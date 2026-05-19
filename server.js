const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_DIR   = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
const SOUNDS_DIR = path.join(DATA_DIR, 'sounds');
if (!fs.existsSync(SOUNDS_DIR)) fs.mkdirSync(SOUNDS_DIR);
const DB_FILE     = path.join(DATA_DIR, 'wettbewerb.json');
const AUTH_FILE   = path.join(DATA_DIR, 'users.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

function readConfig() {
  try { if (fs.existsSync(CONFIG_FILE)) return JSON.parse(fs.readFileSync(CONFIG_FILE,'utf8')); } catch {}
  return { welcomeMessage:'', imprintEnabled:false, imprintText:'', privacyEnabled:false, privacyText:'', baseUrl:'', announcements:[], fanfareStyle:'victory-chime' };
}
function writeConfig(cfg) { fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2)); markDirty(); }

function getLogoExt(mime) {
  const map = { 'image/jpeg':'jpg','image/png':'png','image/gif':'gif','image/webp':'webp','image/svg+xml':'svg' };
  return map[mime] || 'png';
}
function findLogoFile() {
  for (const ext of ['png','jpg','jpeg','gif','webp','svg']) {
    const p = path.join(DATA_DIR, `logo.${ext}`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}
function deleteLogoFiles() {
  for (const ext of ['png','jpg','jpeg','gif','webp','svg']) {
    const p = path.join(DATA_DIR, `logo.${ext}`);
    try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch {}
  }
}
function findIconFile() {
  for (const ext of ['png','jpg','jpeg','gif','webp','svg']) {
    const p = path.join(DATA_DIR, `icon.${ext}`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}
function deleteIconFiles() {
  for (const ext of ['png','jpg','jpeg','gif','webp','svg']) {
    const p = path.join(DATA_DIR, `icon.${ext}`);
    try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch {}
  }
}

const DEFAULT_SETTINGS = {
  wTime:50, wDist:50, limitMotor:60, limitSail:120,
  maxDist:500, distStep:10, rounds:3, dropWorst:false, dropWorstLimbo:false, dropWorstBallon:false, tensionMode:false
};

function readDB() {
  try { if (fs.existsSync(DB_FILE)) return JSON.parse(fs.readFileSync(DB_FILE,'utf8')); } catch {}
  return { contests:[], _nextId:{ c:1, p:1, e:1 } };
}
function writeDB(db) { fs.writeFileSync(DB_FILE, JSON.stringify(db,null,2)); markDirty(); }
function getContest(db, id) { return db.contests.find(c => c.id === parseInt(id)); }

// ── Auth ──────────────────────────────────────────────────────
function hashPw(pw) { return crypto.createHash('sha256').update(pw+'modellflug_salt').digest('hex'); } // legacy, nur noch für Migration
function hashPwBcrypt(pw) { return bcrypt.hashSync(pw, 12); }
function verifyPw(pw, hash) {
  // Support both bcrypt ($2...) and legacy SHA-256 hashes
  if (hash && hash.startsWith('$2')) return bcrypt.compareSync(pw, hash);
  return hash === hashPw(pw); // legacy fallback
}

function readUsers() {
  try { if (fs.existsSync(AUTH_FILE)) return JSON.parse(fs.readFileSync(AUTH_FILE,'utf8')); } catch {}
  return { users:[{ id:1, username:'admin', passwordHash:hashPw('admin'), role:'admin' }], _nextId:2, sessions:{} };
}
function writeUsers(u) { fs.writeFileSync(AUTH_FILE, JSON.stringify(u,null,2)); }

function createSession(userId, role) {
  const token = crypto.randomBytes(32).toString('hex');
  const auth = readUsers();
  auth.sessions = auth.sessions || {};
  const now = Date.now();
  for (const [t,s] of Object.entries(auth.sessions)) { if (s.expires < now) delete auth.sessions[t]; }
  auth.sessions[token] = { userId, role, expires: now + 8*60*60*1000 };
  writeUsers(auth); return token;
}
function getSession(token) {
  if (!token) return null;
  const auth = readUsers();
  const s = (auth.sessions||{})[token];
  return (s && s.expires > Date.now()) ? s : null;
}
function destroySession(token) {
  const auth = readUsers(); delete (auth.sessions||{})[token]; writeUsers(auth);
}

function requireRole(...roles) {
  return (req,res,next) => {
    const sess = getSession(req.headers['x-session-token']);
    if (!sess) return res.status(401).json({ error:'Nicht angemeldet' });
    if (roles.length && !roles.includes(sess.role)) return res.status(403).json({ error:'Kein Zugriff' });
    req.session = sess; next();
  };
}

// Only the master admin (id=1) may manage users
function requireMasterAdmin(req, res, next) {
  const sess = getSession(req.headers['x-session-token']);
  if (!sess) return res.status(401).json({ error:'Nicht angemeldet' });
  if (sess.role !== 'admin' || sess.userId !== 1)
    return res.status(403).json({ error:'Nur der Hauptadministrator kann Benutzer verwalten' });
  req.session = sess; next();
}

// Check if user has access to a contest (owner or in sharedWith list)
function canAccessContest(contest, userId) {
  if (!contest) return false;
  if (contest.ownerId === userId) return true;
  if (contest.sharedWith && contest.sharedWith.includes(userId)) return true;
  return false;
}

function requireContestAccess(req, res, next) {
  const sess = getSession(req.headers['x-session-token']);
  if (!sess) return res.status(401).json({ error:'Nicht angemeldet' });
  req.session = sess;
  const db = readDB();
  const c = getContest(db, req.params.cid || req.params.id);
  if (!c) return res.status(404).json({ error:'Nicht gefunden' });
  if (!canAccessContest(c, sess.userId)) return res.status(403).json({ error:'Kein Zugriff auf diesen Wettbewerb' });
  req.contest = c; req.db = db; next();
}

// ── SSE ──────────────────────────────────────────────────────
const clients = new Set();
function broadcast(event, contestId) {
  const msg = `event: update\ndata: ${JSON.stringify({ event, contestId })}\n\n`;
  for (const c of clients) { try { c.write(msg); } catch {} }
}

// ── HTTPS-Erkennung & Security-Header ────────────────────────
// Unterstützt beide Modi:
//   HTTP  (lokales Netzwerk): minimale Header, kein HSTS, kein CSP
//   HTTPS (Internet, hinter Reverse Proxy): volle Sicherheit
//
// Reverse Proxy muss setzen:
//   proxy_set_header X-Forwarded-Proto https;
//
// Oder: Umgebungsvariable setzen:
//   FORCE_HTTPS=true node server.js

function isSecureRequest(req) {
  return req.headers['x-forwarded-proto'] === 'https'
      || req.protocol === 'https'
      || process.env.FORCE_HTTPS === 'true';
}

// Basis-Header für alle Requests (HTTP + HTTPS)
// Trust reverse proxy (nginx/NPM) for correct IP in rate limiting
app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: false,       // wird dynamisch per Middleware gesetzt
  hsts: false,                        // wird dynamisch gesetzt
  crossOriginEmbedderPolicy: false,
}));

// Dynamische Security-Header je nach HTTP/HTTPS
app.use((req, res, next) => {
  if (isSecureRequest(req)) {
    // HTTPS-Modus: volle Sicherheit
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.setHeader('Content-Security-Policy',
      "default-src 'self'; " +
      "script-src 'self' 'unsafe-inline'; " +
      "style-src 'self' 'unsafe-inline'; " +
      "font-src 'self'; " +
      "img-src 'self' data:; " +
      "connect-src 'self';"
    );
  }
  // Gemeinsame Header (HTTP + HTTPS)
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});


// Rate limiting
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 Minuten
  max: 20,                   // max 20 Versuche
  message: { error: 'Zu viele Anmeldeversuche. Bitte 15 Minuten warten.' },
  standardHeaders: true,
  legacyHeaders: false,
});
const viewerLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Zu viele Passwortversuche. Bitte 15 Minuten warten.' },
});

app.use(express.json({ limit: '200kb' }));

app.get('/', (req, res, next) => {
  if (isFirstSetup()) return res.redirect('/setup');
  next();
});

// Custom app icon — served before static middleware so it can override the bundled files
const _iconMimeMap = { jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png', gif:'image/gif', webp:'image/webp', svg:'image/svg+xml' };
app.get('/app-icon', (req, res) => {
  const iconPath = findIconFile();
  if (iconPath) {
    const ext = path.extname(iconPath).slice(1);
    res.setHeader('Content-Type', _iconMimeMap[ext] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-cache');
    return res.sendFile(iconPath);
  }
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'icon-192.png'));
});

// Dynamic manifest — always references /app-icon so newly uploaded icons are reflected
app.get('/manifest.json', (req, res) => {
  res.setHeader('Content-Type', 'application/manifest+json');
  res.setHeader('Cache-Control', 'no-cache');
  res.json({
    name: 'AeroScore', short_name: 'AeroScore',
    description: 'Wettbewerbsverwaltung für Modellflugvereine',
    start_url: '/', display: 'standalone',
    background_color: '#0a1628', theme_color: '#0a1628', orientation: 'portrait',
    icons: [{ src: '/app-icon', sizes: 'any', type: 'image/png', purpose: 'any maskable' }]
  });
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/events', (req,res) => {
  res.setHeader('Content-Type','text/event-stream');
  res.setHeader('Cache-Control','no-cache');
  res.setHeader('Connection','keep-alive');
  res.setHeader('X-Accel-Buffering','no'); // disable nginx buffering
  res.flushHeaders();
  res.write('event: ping\ndata: ok\n\n');
  const ka = setInterval(() => { try { res.write(':ka\n\n'); } catch {} }, 25000);
  clients.add(res);
  req.on('close', () => { clients.delete(res); clearInterval(ka); });
});

// ── RCLONE BACKUP ─────────────────────────────────────────
const AdmZip = require('adm-zip');
const { execFile } = require('child_process');
const multer = require('multer');
const uploadMiddleware = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

const RCLONE_REMOTE  = process.env.RCLONE_REMOTE || '';   // e.g. 'modellflug-backup'
const RCLONE_PATH    = process.env.RCLONE_PATH   || 'modellflug/';
const BACKUP_INTERVAL= 5 * 60 * 1000; // 5 Minuten
const BACKUP_KEEP    = parseInt(process.env.BACKUP_KEEP || '14'); // Anzahl Backups behalten

let backupDirty    = false;
let lastBackupTime = null;
let lastBackupError= null;
let backupRunning  = false;
let nextBackupTime = null;

function markDirty() { backupDirty = true; }

function pruneOldBackups(dest) {
  // List all backup ZIPs in the remote, delete oldest if > BACKUP_KEEP
  execFile('rclone', ['lsf', dest, '--include', 'aeroscore-export-*.zip', '--format', 'p'], (err, stdout) => {
    if (err) { console.error('[backup] prune list error:', err.message); return; }
    const files = stdout.trim().split('\n')
      .map(l => l.trim()).filter(l => l.endsWith('.zip'))
      .sort(); // ISO timestamps sort correctly alphabetically
    const excess = files.length - BACKUP_KEEP;
    if (excess <= 0) return;
    const toDelete = files.slice(0, excess);
    for (const f of toDelete) {
      execFile('rclone', ['deletefile', dest + f, '--quiet'], err2 => {
        if (err2) console.error('[backup] prune delete error:', f, err2.message);
        else console.log('[backup] pruned old backup:', f);
      });
    }
  });
}

function runBackup() {
  if (!RCLONE_REMOTE || backupRunning || !backupDirty) return;
  backupRunning = true;
  backupDirty   = false;

  try {
    const db   = readDB();
    const auth = readUsers();
    const cfg  = readConfig();
    const zip  = new AdmZip();

    zip.addFile('data/wettbewerb.json', Buffer.from(JSON.stringify(db,   null, 2)));
    zip.addFile('data/users.json',      Buffer.from(JSON.stringify(auth, null, 2)));
    zip.addFile('data/config.json',     Buffer.from(JSON.stringify(cfg,  null, 2)));

    const logoFileRun = findLogoFile();
    if (logoFileRun) {
      const logoExtRun = path.extname(logoFileRun).slice(1);
      zip.addFile(`data/logo.${logoExtRun}`, fs.readFileSync(logoFileRun));
    }
    const iconFileRun = findIconFile();
    if (iconFileRun) {
      const iconExtRun = path.extname(iconFileRun).slice(1);
      zip.addFile(`data/icon.${iconExtRun}`, fs.readFileSync(iconFileRun));
    }

    for (const f of fs.readdirSync(SOUNDS_DIR).filter(f => /\.(mp3|ogg|wav)$/i.test(f))) {
      zip.addFile(`data/sounds/${f}`, fs.readFileSync(path.join(SOUNDS_DIR, f)));
    }

    for (const c of (db.contests||[])) {
      const out = JSON.parse(JSON.stringify(c));
      if (out.settings) { delete out.settings.viewerPasswordHash; delete out.settings.viewerTokens; }
      const slug = (c.name||'contest').replace(/[^a-zA-Z0-9äöüÄÖÜß\-_ ]/g,'_').trim().slice(0,40);
      zip.addFile(`exports/${slug}.json`, Buffer.from(JSON.stringify(out, null, 2)));
    }

    zip.addFile('backup-info.json', Buffer.from(JSON.stringify({
      createdAt: new Date().toISOString(), version: '1.0',
      contestCount: (db.contests||[]).length, userCount: (auth.users||[]).length,
    }, null, 2)));

    // Dateiname mit Datum+Uhrzeit für Eindeutigkeit
    const ts = new Date().toISOString().replace(/[:.]/g,'-').slice(0,19);
    const zipName = `aeroscore-export-${ts}.zip`;
    const zipPath = path.join(DATA_DIR, zipName);
    zip.writeZip(zipPath);

    const dest = `${RCLONE_REMOTE}:${RCLONE_PATH}`;
    execFile('rclone', ['copyto', zipPath, `${dest}${zipName}`, '--quiet'], (err) => {
      try { fs.unlinkSync(zipPath); } catch {}
      backupRunning = false;
      if (err) {
        lastBackupError = err.message.slice(0, 200);
        backupDirty = true;
        console.error('[backup] rclone error:', err.message);
      } else {
        lastBackupTime  = new Date().toISOString();
        lastBackupError = null;
        console.log('[backup] OK →', dest + zipName);
        // Rotation: alte Backups löschen
        pruneOldBackups(dest);
      }
    });
  } catch(e) {
    backupRunning = false;
    backupDirty   = true;
    lastBackupError = e.message;
    console.error('[backup] ZIP error:', e.message);
  }
}

if (RCLONE_REMOTE) {
  const tick = () => {
    nextBackupTime = new Date(Date.now() + BACKUP_INTERVAL).toISOString();
    setTimeout(() => { runBackup(); tick(); }, BACKUP_INTERVAL);
  };
  tick();
  console.log(`[backup] rclone configured → ${RCLONE_REMOTE}:${RCLONE_PATH} (keep ${BACKUP_KEEP})`);
} else {
  console.log('[backup] rclone not configured (set RCLONE_REMOTE env var to enable)');
}

// ── BACKUP API ────────────────────────────────────────────
app.get('/api/backup/status', requireRole('admin'), (req, res) => {
  res.json({
    configured: !!RCLONE_REMOTE,
    remote:     RCLONE_REMOTE,
    path:       RCLONE_PATH,
    keep:       BACKUP_KEEP,
    lastBackup: lastBackupTime,
    lastError:  lastBackupError,
    nextBackup: nextBackupTime,
  });
});

app.post('/api/backup/now', requireRole('admin'), (req, res) => {
  if (!RCLONE_REMOTE) return res.json({ ok:false, error:'rclone nicht konfiguriert' });
  if (backupRunning)  return res.json({ ok:false, error:'Backup läuft bereits' });
  backupDirty = true;
  runBackup();
  res.json({ ok: true });
});

// ── BACKUP ZIP erstellen & herunterladen ─────────────────────
function createBackupZip() {
  const zip  = new AdmZip();
  const db   = readDB();
  const auth = readUsers();
  const cfg  = readConfig();

  // Full data files for restore
  zip.addFile('data/wettbewerb.json', Buffer.from(JSON.stringify(db,   null, 2)));
  zip.addFile('data/users.json',      Buffer.from(JSON.stringify(auth, null, 2)));
  zip.addFile('data/config.json',     Buffer.from(JSON.stringify(cfg,  null, 2)));

  const logoFileDL = findLogoFile();
  if (logoFileDL) {
    const logoExtDL = path.extname(logoFileDL).slice(1);
    zip.addFile(`data/logo.${logoExtDL}`, fs.readFileSync(logoFileDL));
  }
  const iconFileDL = findIconFile();
  if (iconFileDL) {
    const iconExtDL = path.extname(iconFileDL).slice(1);
    zip.addFile(`data/icon.${iconExtDL}`, fs.readFileSync(iconFileDL));
  }

  for (const f of fs.readdirSync(SOUNDS_DIR).filter(f => /\.(mp3|ogg|wav)$/i.test(f))) {
    zip.addFile(`data/sounds/${f}`, fs.readFileSync(path.join(SOUNDS_DIR, f)));
  }

  // Individual contest exports (sanitized, no passwords)
  for (const c of (db.contests || [])) {
    const safe = (c.name||'contest').replace(/[^a-zA-Z0-9äöüÄÖÜß\-_ ]/g,'_').trim().slice(0,60);
    const out  = JSON.parse(JSON.stringify(c));
    if (out.settings) { delete out.settings.viewerPasswordHash; delete out.settings.viewerTokens; }
    zip.addFile(`exports/${safe}.json`, Buffer.from(JSON.stringify(out, null, 2)));
  }

  zip.addFile('backup-info.json', Buffer.from(JSON.stringify({
    createdAt:    new Date().toISOString(),
    version:      '1.0',
    contestCount: (db.contests||[]).length,
    userCount:    (auth.users||[]).length,
  }, null, 2)));

  return zip.toBuffer();
}

app.get('/api/backup/download', requireRole('admin'), (req, res) => {
  try {
    const buf = createBackupZip();
    const date = new Date().toISOString().slice(0,10);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="aeroscore-export-${date}.zip"`);
    res.send(buf);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── RESTORE ───────────────────────────────────────────────────
function isFirstSetup() {
  return !fs.existsSync(AUTH_FILE) ||
    JSON.parse(fs.readFileSync(AUTH_FILE,'utf8')).users?.length === 0;
}

function applyRestoreZip(buffer) {
  const zip = new AdmZip(buffer);
  const info = zip.getEntry('backup-info.json');
  if (!info) throw new Error('Keine gültige Backup-ZIP (backup-info.json fehlt)');

  ['data/wettbewerb.json', 'data/config.json'].forEach(entry => {
    const e = zip.getEntry(entry);
    if (e) {
      const dest = path.join(__dirname, entry);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, e.getData());
    }
  });
  // Users restore
  const usersEntry = zip.getEntry('data/users.json');
  if (usersEntry) fs.writeFileSync(AUTH_FILE, usersEntry.getData());

  // Logo restore
  deleteLogoFiles();
  for (const ext of ['png','jpg','jpeg','gif','webp','svg']) {
    const logoEntry = zip.getEntry(`data/logo.${ext}`);
    if (logoEntry) { fs.writeFileSync(path.join(DATA_DIR, `logo.${ext}`), logoEntry.getData()); break; }
  }

  // Icon restore
  deleteIconFiles();
  for (const ext of ['png','jpg','jpeg','gif','webp','svg']) {
    const iconEntry = zip.getEntry(`data/icon.${ext}`);
    if (iconEntry) { fs.writeFileSync(path.join(DATA_DIR, `icon.${ext}`), iconEntry.getData()); break; }
  }

  // Sounds restore
  if (!fs.existsSync(SOUNDS_DIR)) fs.mkdirSync(SOUNDS_DIR, { recursive: true });
  for (const entry of zip.getEntries()) {
    const name = entry.entryName;
    if (name.startsWith('data/sounds/') && /\.(mp3|ogg|wav)$/i.test(name)) {
      const filename = path.basename(name);
      if (filename && !filename.includes('..')) {
        fs.writeFileSync(path.join(SOUNDS_DIR, filename), entry.getData());
      }
    }
  }

  return JSON.parse(info.getData().toString());
}

// Restore als Admin
app.post('/api/restore', requireRole('admin'), uploadMiddleware.single('backup'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Keine Datei' });
  try {
    const info = applyRestoreZip(req.file.buffer);
    broadcast('all', null);
    res.json({ ok: true, info });
  } catch(e) { res.status(400).json({ error: e.message }); }
});

// Restore beim Erststart (keine users.json vorhanden)
app.post('/api/setup/restore', uploadMiddleware.single('backup'), (req, res) => {
  if (!isFirstSetup()) return res.status(403).json({ error: 'Nur beim Erststart möglich' });
  if (!req.file) return res.status(400).json({ error: 'Keine Datei' });
  try {
    const info = applyRestoreZip(req.file.buffer);
    broadcast('all', null);
    res.json({ ok: true, info });
  } catch(e) { res.status(400).json({ error: e.message }); }
});

// Erststart-Status (für Setup-Seite)
app.get('/api/setup/status', (req, res) => {
  res.json({ firstSetup: isFirstSetup() });
});

// Erststart: Admin manuell anlegen
app.post('/api/setup/init', (req, res) => {
  if (!isFirstSetup()) return res.status(403).json({ error: 'Nur beim Erststart möglich' });
  const { username, password } = req.body;
  if (!username || !password || password.length < 6)
    return res.status(400).json({ error: 'Benutzername und Passwort (min. 6 Zeichen) erforderlich' });
  const auth = { users: [], sessions: {}, _nextId: 2 };
  auth.users.push({ id: 1, username: username.trim(), passwordHash: hashPwBcrypt(password), role: 'admin' });
  writeUsers(auth);
  res.json({ ok: true });
});



app.get('/api/config', (req,res) => {
  const cfg = readConfig();
  cfg.hasLogo = !!findLogoFile();
  cfg.hasIcon = !!findIconFile();
  res.json(cfg);
});
app.put('/api/config', requireRole('admin'), (req,res) => {
  const cfg = readConfig();
  if (req.body.welcomeMessage !== undefined) cfg.welcomeMessage = String(req.body.welcomeMessage).slice(0, 500);
  if (req.body.imprintEnabled !== undefined) cfg.imprintEnabled = !!req.body.imprintEnabled;
  if (req.body.imprintText   !== undefined) cfg.imprintText    = String(req.body.imprintText).slice(0, 10000);
  if (req.body.privacyEnabled !== undefined) cfg.privacyEnabled = !!req.body.privacyEnabled;
  if (req.body.privacyText   !== undefined) cfg.privacyText    = String(req.body.privacyText).slice(0, 10000);
  if (req.body.baseUrl       !== undefined) cfg.baseUrl        = String(req.body.baseUrl).replace(/\/+$/, '').slice(0, 500);
  if (req.body.fanfareStyle !== undefined) {
    const style = req.body.fanfareStyle;
    const builtIn = ['victory-chime','goodresult','victory-chime','winner-game-sound'];
    if (builtIn.includes(style)) {
      cfg.fanfareStyle = style;
    } else if (typeof style === 'string' && style.startsWith('custom:')) {
      const fn = path.basename(style.slice(7));
      if (/\.(mp3|ogg|wav)$/i.test(fn) && fs.existsSync(path.join(SOUNDS_DIR, fn))) {
        cfg.fanfareStyle = 'custom:' + fn;
      }
    } else {
      cfg.fanfareStyle = 'victory-chime';
    }
  }
  if (req.body.announcements !== undefined && Array.isArray(req.body.announcements)) {
    let nextId = Math.max(0, ...(cfg.announcements||[]).map(a=>a.id||0)) + 1;
    cfg.announcements = req.body.announcements.slice(0, 20).map(a => ({
      id: (Number.isInteger(a.id) && a.id > 0) ? a.id : nextId++,
      text: String(a.text||'').slice(0, 500),
      type: ['info','warning','success'].includes(a.type) ? a.type : 'info',
      active: !!a.active
    }));
  }
  writeConfig(cfg);
  broadcast('all', null);
  res.json({ ok:true });
});

// ── LOGO API ─────────────────────────────────────────────────
app.get('/api/config/logo', (req, res) => {
  const logoPath = findLogoFile();
  if (!logoPath) return res.status(404).json({ error: 'Kein Logo' });
  const ext = path.extname(logoPath).slice(1);
  const mimeMap = { jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png', gif:'image/gif', webp:'image/webp', svg:'image/svg+xml' };
  res.setHeader('Content-Type', mimeMap[ext] || 'application/octet-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(logoPath);
});

app.post('/api/config/logo', requireRole('admin'), uploadMiddleware.single('logo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Keine Datei' });
  const allowed = ['image/jpeg','image/png','image/gif','image/webp','image/svg+xml'];
  if (!allowed.includes(req.file.mimetype)) return res.status(400).json({ error: 'Ungültiges Format (PNG, JPG, GIF, WEBP oder SVG)' });
  if (req.file.size > 2 * 1024 * 1024) return res.status(400).json({ error: 'Logo zu groß (max. 2 MB)' });
  deleteLogoFiles();
  const ext = getLogoExt(req.file.mimetype);
  fs.writeFileSync(path.join(DATA_DIR, `logo.${ext}`), req.file.buffer);
  markDirty();
  res.json({ ok: true });
});

app.delete('/api/config/logo', requireRole('admin'), (req, res) => {
  deleteLogoFiles();
  markDirty();
  res.json({ ok: true });
});

// ── ICON API ──────────────────────────────────────────────────
app.get('/api/config/icon', (req, res) => {
  const iconPath = findIconFile();
  if (!iconPath) return res.status(404).json({ error: 'Kein Icon' });
  const ext = path.extname(iconPath).slice(1);
  res.setHeader('Content-Type', _iconMimeMap[ext] || 'application/octet-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(iconPath);
});

app.post('/api/config/icon', requireRole('admin'), uploadMiddleware.single('icon'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Keine Datei' });
  const allowed = ['image/jpeg','image/png','image/gif','image/webp','image/svg+xml'];
  if (!allowed.includes(req.file.mimetype)) return res.status(400).json({ error: 'Ungültiges Format (PNG, JPG, GIF, WEBP oder SVG)' });
  if (req.file.size > 2 * 1024 * 1024) return res.status(400).json({ error: 'Icon zu groß (max. 2 MB)' });
  deleteIconFiles();
  const ext = getLogoExt(req.file.mimetype);
  fs.writeFileSync(path.join(DATA_DIR, `icon.${ext}`), req.file.buffer);
  markDirty();
  res.json({ ok: true });
});

app.delete('/api/config/icon', requireRole('admin'), (req, res) => {
  deleteIconFiles();
  markDirty();
  res.json({ ok: true });
});

// ── SOUNDS API ────────────────────────────────────────────────
const ALLOWED_SOUND_MIME = new Set(['audio/mpeg','audio/ogg','audio/wav','audio/wave','audio/x-wav','audio/mp3']);

app.get('/api/sounds', requireRole('admin','user'), (req, res) => {
  const files = fs.readdirSync(SOUNDS_DIR).filter(f => /\.(mp3|ogg|wav)$/i.test(f));
  res.json(files.map(f => ({ filename: f })));
});

app.get('/api/sounds/:filename', (req, res) => {
  const filename = path.basename(req.params.filename);
  if (!/\.(mp3|ogg|wav)$/i.test(filename)) return res.status(400).json({ error: 'Ungültiger Dateiname' });
  const filePath = path.join(SOUNDS_DIR, filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Nicht gefunden' });
  const ext = path.extname(filename).slice(1).toLowerCase();
  const mimeMap = { mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav' };
  res.setHeader('Content-Type', mimeMap[ext] || 'audio/octet-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(filePath);
});

app.post('/api/sounds', requireRole('admin'), uploadMiddleware.single('sound'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Keine Datei' });
  if (!ALLOWED_SOUND_MIME.has(req.file.mimetype)) return res.status(400).json({ error: 'Ungültiges Format (MP3, OGG oder WAV)' });
  if (req.file.size > 10 * 1024 * 1024) return res.status(400).json({ error: 'Datei zu groß (max. 10 MB)' });
  const rawName = req.file.originalname || 'sound';
  const safeName = rawName.replace(/[^a-zA-Z0-9äöüÄÖÜß._\-]/g, '_').replace(/\.{2,}/g, '.').slice(0, 100);
  const ext = path.extname(safeName).toLowerCase() || '.ogg';
  const base = path.basename(safeName, ext).slice(0, 80) || 'sound';
  let filename = base + ext;
  let i = 1;
  while (fs.existsSync(path.join(SOUNDS_DIR, filename))) { filename = `${base}_${i++}${ext}`; }
  fs.writeFileSync(path.join(SOUNDS_DIR, filename), req.file.buffer);
  markDirty();
  res.json({ ok: true, filename });
});

app.delete('/api/sounds/:filename', requireRole('admin'), (req, res) => {
  const filename = path.basename(req.params.filename);
  if (!/\.(mp3|ogg|wav)$/i.test(filename)) return res.status(400).json({ error: 'Ungültiger Dateiname' });
  const filePath = path.join(SOUNDS_DIR, filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Nicht gefunden' });
  fs.unlinkSync(filePath);
  const cfg = readConfig();
  if (cfg.fanfareStyle === 'custom:' + filename) {
    cfg.fanfareStyle = 'victory-chime';
    writeConfig(cfg);
    broadcast('all', null);
  } else {
    markDirty();
  }
  res.json({ ok: true });
});

// Legal pages
function legalPage(title, content) {
  return `<!DOCTYPE html><html lang="de"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — AeroScore</title>
<style>
  body{font-family:Arial,Helvetica,sans-serif;max-width:800px;margin:0 auto;padding:32px 24px;color:#111;line-height:1.7;background:#fff}
  h1{font-size:26px;font-weight:900;margin-bottom:4px}
  .back{display:inline-block;margin-bottom:28px;color:#4da6ff;text-decoration:none;font-size:14px}
  .back:hover{text-decoration:underline}
  .content{white-space:pre-wrap;font-size:15px}
  hr{border:none;border-top:1px solid #ddd;margin:24px 0}
  .footer{margin-top:40px;font-size:12px;color:#999}
</style></head><body>
<a class="back" href="/welcome">← Zurück</a>
<h1>${title}</h1><hr>
<div class="content">${content.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</div>
<div class="footer">AeroScore</div>
</body></html>`;
}

app.get('/impressum', (req,res) => {
  const cfg = readConfig();
  if (!cfg.imprintEnabled) return res.status(404).send('Kein Impressum vorhanden.');
  res.send(legalPage('Impressum', cfg.imprintText||''));
});

app.get('/datenschutz', (req,res) => {
  const cfg = readConfig();
  if (!cfg.privacyEnabled) return res.status(404).send('Keine Datenschutzerklärung vorhanden.');
  res.send(legalPage('Datenschutzerklärung', cfg.privacyText||''));
});

// ── Auth endpoints ────────────────────────────────────────────
app.post('/api/auth/login', authLimiter, (req,res) => {
  const { username, password } = req.body;
  const auth = readUsers();
  const user = auth.users.find(u => u.username===username);
  if (!user || !verifyPw(password, user.passwordHash)) return res.status(401).json({ error:'Benutzername oder Passwort falsch' });
  // Upgrade legacy SHA-256 hash to bcrypt on successful login
  if (user.passwordHash && !user.passwordHash.startsWith('$2')) {
    user.passwordHash = hashPwBcrypt(password);
    writeUsers(auth);
  }

  const token = createSession(user.id, user.role);
  res.json({ token, role:user.role, username:user.username, userId:user.id });
});
app.post('/api/auth/logout', (req,res) => {
  destroySession(req.headers['x-session-token']); res.json({ ok:true });
});
app.get('/api/auth/me', (req,res) => {
  const sess = getSession(req.headers['x-session-token']);
  if (!sess) return res.json({ loggedIn:false });
  const auth = readUsers();
  const user = auth.users.find(u => u.id===sess.userId);
  res.json({ loggedIn:true, role:sess.role, username:user?.username, userId:sess.userId });
});

// ── Users (admin only) ────────────────────────────────────────
// Lightweight user list for sharing (any logged-in user)
app.get('/api/users/list', requireRole('admin','user'), (req,res) => {
  const auth = readUsers();
  // Only return non-admin users (users that can be shared with)
  res.json(auth.users
    .filter(u => u.role === 'user')
    .map(u => ({ id:u.id, username:u.username })));
});

app.get('/api/users', requireMasterAdmin, (req,res) => {
  const auth = readUsers();
  res.json(auth.users.map(u => ({ id:u.id, username:u.username, role:u.role })));
});
app.post('/api/users', requireMasterAdmin, (req,res) => {
  const { username, password } = req.body;
  if (!username||!password) return res.status(400).json({ error:'Username und Passwort erforderlich' });
  if (password.length < 6) return res.status(400).json({ error:'Passwort muss mindestens 6 Zeichen haben' });
  const auth = readUsers();
  if (auth.users.find(u => u.username===username)) return res.status(409).json({ error:'Benutzername bereits vergeben' });
  if (!auth._nextId) auth._nextId = Math.max(0, ...auth.users.map(u => u.id || 0)) + 1;
  const id = auth._nextId++;
  auth.users.push({ id, username, passwordHash:hashPwBcrypt(password), role:'user' });
  writeUsers(auth); res.json({ id, username, role:'user' });
});
app.put('/api/users/:id', requireMasterAdmin, (req,res) => {
  const id = parseInt(req.params.id);
  const { username, password } = req.body;
  const auth = readUsers();
  const idx = auth.users.findIndex(u => u.id===id);
  if (idx===-1) return res.status(404).json({ error:'Nicht gefunden' });
  if (username && auth.users.find(u => u.username===username && u.id!==id))
    return res.status(409).json({ error:'Benutzername bereits vergeben' });
  if (username) auth.users[idx].username = username;
  if (password) {
    if (password.length < 6) return res.status(400).json({ error:'Passwort muss mindestens 6 Zeichen haben' });
    auth.users[idx].passwordHash = hashPwBcrypt(password);
  }
  writeUsers(auth); res.json({ ok:true });
});
app.delete('/api/users/:id', requireMasterAdmin, (req,res) => {
  const id = parseInt(req.params.id);
  if (id === 1) return res.status(400).json({ error:'Der Hauptadministrator kann nicht gelöscht werden' });
  const auth = readUsers();
  auth.users = auth.users.filter(u => u.id!==id);
  if (auth.sessions) {
    for (const [token, sess] of Object.entries(auth.sessions)) {
      if (sess.userId === id) delete auth.sessions[token];
    }
  }
  writeUsers(auth);
  const db = readDB();
  const before = db.contests.length;
  db.contests = db.contests.filter(c => c.ownerId !== id);
  if (db.contests.length !== before) { writeDB(db); broadcast('all', null); }
  res.json({ ok:true });
});

// ── Contests ──────────────────────────────────────────────────
// List: only return contests the user owns or has shared access to
app.get('/api/contests', (req,res) => {
  const sess = getSession(req.headers['x-session-token']);
  const db = readDB();
  let list = db.contests;
  // If logged in as user (not admin), filter to own + shared contests
  if (sess && sess.role !== 'admin') {
    list = list.filter(c => canAccessContest(c, sess.userId));
  }
  const auth = readUsers();
  res.json(list.map(c => {
    const owner = auth.users.find(u => u.id === c.ownerId);
    return {
      id:c.id, name:c.name, status:c.status, createdAt:c.createdAt, date:c.date||'',
      ownerId:c.ownerId, ownerName:owner?.username||'',
      sharedWith:c.sharedWith||[],
      participantCount:(c.participants||[]).length,
      entryCount:(c.entries||[]).length,
      hasViewerPassword: !!(c.settings?.viewerPasswordHash)
    };
  }));
});

app.post('/api/contests', requireRole('admin','user'), (req,res) => {
  const db = readDB();
  const name = (req.body.name || '').trim();
  // Check for duplicate name (case-insensitive, across all non-archived contests)
  const duplicate = db.contests.find(c =>
    c.status !== 'archived' && c.name.trim().toLowerCase() === name.toLowerCase()
  );
  if (duplicate) return res.status(409).json({ error: `Ein Wettbewerb mit dem Namen „${duplicate.name}" existiert bereits.` });
  if (!db._nextId) db._nextId = { c:1, p:1, e:1 };
  const id = db._nextId.c++;
  const contest = {
    id, name: req.body.name || 'Wettbewerb '+id,
    status:'active', createdAt: new Date().toISOString(),
    date: req.body.date || '',
    ownerId: req.session.userId,  // track owner
    sharedWith: [],               // user IDs with access
    settings: { ...DEFAULT_SETTINGS, ...req.body.settings },
    participants:[], entries:[], _nextId:{ p:1, e:1 }
  };
  db.contests.push(contest);
  writeDB(db); broadcast('contests', id); res.json(contest);
});

app.get('/api/contests/:id', (req,res) => {
  const sess = getSession(req.headers['x-session-token']);
  const db = readDB();
  const c = getContest(db, req.params.id);
  if (!c) return res.status(404).json({ error:'Nicht gefunden' });
  // If contest has a viewer password, require auth (session OR valid viewer token)
  if (c.settings && c.settings.viewerPasswordHash) {
    const viewerToken = req.headers['x-viewer-token'];
    const isViewerOk = viewerToken && (c.settings.viewerTokens||{})[viewerToken] > Date.now();
    const isSessOk = sess && (sess.role === 'admin' || canAccessContest(c, sess.userId));
    if (!isViewerOk && !isSessOk) {
      return res.status(401).json({ error:'Viewer-Passwort erforderlich', needsViewerAuth: true });
    }
  }
  // Strip sensitive fields before returning
  const out = {...c};
  const hasViewerPassword = !!(c.settings?.viewerPasswordHash);
  if (out.settings) { out.settings = {...out.settings}; delete out.settings.viewerPasswordHash; delete out.settings.viewerTokens; }
  out.hasViewerPassword = hasViewerPassword;
  res.json(out);
});

// Viewer auth: verify leaderboard password, return short-lived viewer token
app.post('/api/contests/:id/viewer-auth', viewerLimiter, (req,res) => {
  const db = readDB();
  const c = getContest(db, req.params.id);
  if (!c) return res.status(404).json({ error:'Nicht gefunden' });
  if (!c.settings?.viewerPasswordHash) return res.json({ ok:true, noPassword:true });
  const pw = req.body.password||'';
  if (hashPw(pw) !== c.settings.viewerPasswordHash) {
    return res.status(401).json({ error:'Falsches Passwort' });
  }
  const token = crypto.randomBytes(24).toString('hex');
  c.settings.viewerTokens = c.settings.viewerTokens || {};
  // Clean expired tokens
  const now = Date.now();
  for (const t of Object.keys(c.settings.viewerTokens)) {
    if (c.settings.viewerTokens[t] < now) delete c.settings.viewerTokens[t];
  }
  c.settings.viewerTokens[token] = now + 24*60*60*1000; // 24h
  writeDB(db);
  res.json({ ok:true, token });
});


app.put('/api/contests/:id', requireContestAccess, (req,res) => {
  const c = req.contest, db = req.db;
  if (req.body.name && req.body.name.trim() !== c.name.trim()) {
    const newName = req.body.name.trim();
    const duplicate = db.contests.find(x =>
      x.id !== c.id && x.status !== 'archived' &&
      x.name.trim().toLowerCase() === newName.toLowerCase()
    );
    if (duplicate) return res.status(409).json({ error: `Ein Wettbewerb mit dem Namen „${duplicate.name}" existiert bereits.` });
  }
  if (req.body.name) c.name = req.body.name;
  if (req.body.status) {
    if (req.body.status === 'finished' && c.status !== 'finished') c.finishedAt = new Date().toISOString();
    if (req.body.status !== 'finished') delete c.finishedAt;
    c.status = req.body.status;
  }
  if (req.body.date !== undefined) c.date = req.body.date;
  if (req.body.location !== undefined) c.location = req.body.location;
  if (req.body.settings) c.settings = { ...DEFAULT_SETTINGS, ...c.settings, ...req.body.settings };
  // Handle viewer password update
  if (req.body.viewerPassword !== undefined) {
    if (req.body.viewerPassword === '') {
      // Remove password protection
      delete c.settings.viewerPasswordHash;
      delete c.settings.viewerTokens;
    } else {
      c.settings.viewerPasswordHash = hashPw(req.body.viewerPassword);
      c.settings.viewerTokens = {};
    }
  }
  writeDB(db); broadcast('contests', c.id); res.json({ ok:true });
});

app.delete('/api/contests/:id', requireContestAccess, (req,res) => {
  const db = req.db;
  db.contests = db.contests.filter(c => c.id !== parseInt(req.params.id));
  writeDB(db); broadcast('contests', null); res.json({ ok:true });
});

app.post('/api/contests/:id/duplicate', requireContestAccess, (req,res) => {
  const src = req.contest, db = req.db;
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name erforderlich' });
  const duplicate = db.contests.find(c =>
    c.status !== 'archived' && c.name.trim().toLowerCase() === name.toLowerCase()
  );
  if (duplicate) return res.status(409).json({ error: `Ein Wettbewerb mit dem Namen „${duplicate.name}" existiert bereits.` });
  if (!db._nextId) db._nextId = { c:1, p:1, e:1 };
  const id = db._nextId.c++;
  const settings = { ...src.settings };
  delete settings.viewerPasswordHash;
  delete settings.viewerTokens;
  const contest = {
    id, name,
    status: 'active', createdAt: new Date().toISOString(),
    date: src.date || '',
    location: src.location || '',
    ownerId: req.session.userId,
    sharedWith: [],
    settings,
    participants: JSON.parse(JSON.stringify(src.participants || [])),
    entries: [],
    _nextId: { p: src._nextId?.p || 1, e: 1 }
  };
  db.contests.push(contest);
  writeDB(db); broadcast('contests', id); res.json(contest);
});

// ── Contest sharing ───────────────────────────────────────────
// GET shared users for a contest
app.get('/api/contests/:id/access', requireContestAccess, (req,res) => {
  const c = req.contest;
  const auth = readUsers();
  const sharedUsers = (c.sharedWith||[]).map(uid => {
    const u = auth.users.find(u => u.id===uid);
    return u ? { id:u.id, username:u.username } : null;
  }).filter(Boolean);
  res.json({ ownerId: c.ownerId, sharedWith: sharedUsers });
});

// Grant access to a user
app.post('/api/contests/:id/access', requireContestAccess, (req,res) => {
  const c = req.contest, db = req.db;
  // Only the owner can share
  if (c.ownerId !== req.session.userId) return res.status(403).json({ error:'Nur der Ersteller kann Zugriff vergeben' });
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error:'userId fehlt' });
  if (!c.sharedWith) c.sharedWith = [];
  if (!c.sharedWith.includes(userId)) c.sharedWith.push(userId);
  writeDB(db); res.json({ ok:true });
});

// Revoke access
app.delete('/api/contests/:id/access/:userId', requireContestAccess, (req,res) => {
  const c = req.contest, db = req.db;
  if (c.ownerId !== req.session.userId) return res.status(403).json({ error:'Nur der Ersteller kann Zugriff entziehen' });
  c.sharedWith = (c.sharedWith||[]).filter(uid => uid !== parseInt(req.params.userId));
  writeDB(db); res.json({ ok:true });
});

// ── Participants ───────────────────────────────────────────────
// Middleware: allow session users with access OR valid viewer token
function requireViewerOrSession(req, res, next) {
  const db = readDB();
  const c = getContest(db, req.params.cid || req.params.id);
  if (!c) return res.status(404).json({ error:'Nicht gefunden' });
  // If no viewer password, public access OK
  if (!c.settings?.viewerPasswordHash) { req.contest = c; return next(); }
  // Check session
  const sess = getSession(req.headers['x-session-token']);
  if (sess && (sess.role === 'admin' || canAccessContest(c, sess.userId))) { req.contest = c; return next(); }
  // Check viewer token
  const vt = req.headers['x-viewer-token'];
  if (vt && (c.settings.viewerTokens||{})[vt] > Date.now()) { req.contest = c; return next(); }
  return res.status(401).json({ error:'Viewer-Passwort erforderlich', needsViewerAuth: true });
}

app.get('/api/contests/:cid/participants', requireViewerOrSession, (req,res) => {
  const c = req.contest;
  res.json([...(c.participants||[])].sort((a,b) => a.number-b.number));
});
app.post('/api/contests/:cid/participants', requireContestAccess, (req,res) => {
  const c = req.contest, db = req.db;
  const { name, number, youth, planeType } = req.body;
  if (!name) return res.status(400).json({ error:'Name fehlt' });
  const existing = c.participants.find(p => p.name===name);
  // Return existing participant so offline sync can remap temp IDs
  if (existing) return res.status(409).json({ error:'Name bereits vorhanden', existing });
  const id = c._nextId.p++;
  const p = { id, name, number, youth:!!youth, planeType:planeType||'sail', lost:false };
  c.participants.push(p);
  writeDB(db); broadcast('participants', c.id); res.json(p);
});
app.put('/api/contests/:cid/participants/:id', requireContestAccess, (req,res) => {
  const c = req.contest, db = req.db;
  const idx = c.participants.findIndex(p => p.id===parseInt(req.params.id));
  if (idx===-1) return res.status(404).json({ error:'Nicht gefunden' });
  const { name, number, youth, planeType, lost } = req.body;
  if (name && c.participants.find(p => p.name===name && p.id!==parseInt(req.params.id)))
    return res.status(409).json({ error:'Name bereits vorhanden' });
  c.participants[idx] = { ...c.participants[idx],
    ...(name&&{name}), ...(number!=null&&{number}),
    ...(youth!=null&&{youth:!!youth}), ...(planeType&&{planeType}), ...(lost!=null&&{lost:!!lost}) };
  writeDB(db); broadcast('participants', c.id); res.json({ ok:true });
});
app.delete('/api/contests/:cid/participants/:id', requireContestAccess, (req,res) => {
  const c = req.contest, db = req.db;
  const pid = parseInt(req.params.id);
  c.participants = c.participants.filter(p => p.id!==pid);
  c.entries = c.entries.filter(e => e.pilotId!==pid);
  writeDB(db); broadcast('participants', c.id); res.json({ ok:true });
});

// ── Entries ───────────────────────────────────────────────────
app.get('/api/contests/:cid/entries', requireViewerOrSession, (req,res) => {
  const c = req.contest;
  res.json([...(c.entries||[])].reverse());
});
app.post('/api/contests/:cid/entries', requireContestAccess, (req,res) => {
  const c = req.contest, db = req.db;
  // Idempotency: if clientId already exists, return that entry (prevents offline duplicate on retry)
  if (req.body.clientId) {
    const dup = c.entries.find(e => e.clientId === req.body.clientId);
    if (dup) return res.json(dup);
  }
  // Verify pilot exists
  if (req.body.pilotId && !c.participants.find(p => p.id === req.body.pilotId)) {
    return res.status(404).json({ error:'Pilot nicht gefunden', pilotNotFound:true });
  }
  const id = c._nextId.e++;
  const entry = { id, ...req.body };
  c.entries.push(entry);
  writeDB(db); broadcast('entries', c.id); res.json(entry);
});
app.put('/api/contests/:cid/entries/:id', requireContestAccess, (req,res) => {
  const c = req.contest, db = req.db;
  const idx = c.entries.findIndex(e => e.id===parseInt(req.params.id));
  if (idx===-1) return res.status(404).json({ error:'Nicht gefunden' });
  c.entries[idx] = { ...c.entries[idx], ...req.body, id:parseInt(req.params.id) };
  writeDB(db); broadcast('entries', c.id); res.json({ ok:true });
});
app.delete('/api/contests/:cid/entries/:id', requireContestAccess, (req,res) => {
  const c = req.contest, db = req.db;
  c.entries = c.entries.filter(e => e.id!==parseInt(req.params.id));
  writeDB(db); broadcast('entries', c.id); res.json({ ok:true });
});
app.post('/api/contests/:cid/entries/recalculate', requireContestAccess, (req,res) => {
  const c = req.contest, db = req.db;
  const map = {};
  for (const e of (req.body.entries||[])) map[e.id] = e;
  c.entries = c.entries.map(e => map[e.id] ? { ...e, ...map[e.id] } : e);
  writeDB(db); broadcast('entries', c.id); res.json({ ok:true });
});

app.get('/api/contests/:id/export', requireContestAccess, (req,res) => {
  const out = JSON.parse(JSON.stringify(req.contest));
  if (out.settings) { delete out.settings.viewerPasswordHash; delete out.settings.viewerTokens; }
  res.json(out);
});

// ── Admin: full reset ────────────────────────────────────────
app.delete('/api/reset', requireRole('admin'), (req,res) => {
  writeDB({ contests:[], _nextId:{ c:1, p:1, e:1 } });
  broadcast('all', null);
  res.json({ ok:true });
});

// Welcome page for visitors (contest selection)
app.get('/setup', (req,res) => {
  res.sendFile(path.join(__dirname, 'public', 'setup.html'));
});

app.get('/welcome', (req,res) => {
  res.sendFile(path.join(__dirname, 'public', 'welcome.html'));
});

function autoArchiveContests() {
  const db = readDB();
  const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
  let changed = false;
  db.contests.forEach(c => {
    if (c.status === 'finished' && c.finishedAt && new Date(c.finishedAt).getTime() < cutoff) {
      c.status = 'archived';
      changed = true;
      console.log(`[auto-archive] "${c.name}" archiviert (abgeschlossen seit ${c.finishedAt})`);
    }
  });
  if (changed) { writeDB(db); broadcast('all', null); }
}

autoArchiveContests();
setInterval(autoArchiveContests, 60 * 60 * 1000); // stündlich prüfen

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✈  AeroScore – Wettbewerb-Server\n`);
  console.log(`   http://localhost:${PORT}\n`);
  if (isFirstSetup()) {
    console.log(`   ⚠️  Ersteinrichtung erforderlich → http://localhost:${PORT}/setup\n`);
  } else {
    const auth = readUsers();
    auth.users.forEach(u => console.log(`   ${u.username} (${u.role})`));
  }
});
