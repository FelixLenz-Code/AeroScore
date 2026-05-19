const CACHE = 'aeroscore-v11';

const PRECACHE = [
  '/index.html',
  '/welcome.html',
  '/manifest.json',
  '/qrcode.min.js',
  '/fonts/fonts.css',
  '/fonts/barlow-400.ttf',
  '/fonts/barlow-500.ttf',
  '/fonts/barlow-600.ttf',
  '/fonts/barlow-condensed-400.ttf',
  '/fonts/barlow-condensed-500.ttf',
  '/fonts/barlow-condensed-600.ttf',
  '/fonts/barlow-condensed-700.ttf',
  '/fonts/barlow-condensed-800.ttf',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const { request } = e;
  const url = new URL(request.url);

  // Non-GET requests: pass through; main JS handles offline queuing for mutations
  if (request.method !== 'GET') return;

  // Blob/data URLs (e.g. synthesised audio) are not accessible from the SW context
  if (url.protocol === 'blob:' || url.protocol === 'data:') return;

  // Audio files: bypass SW entirely — browsers send Range requests for media and
  // a cached full 200 response breaks seekable playback (especially on Safari).
  if (/\.(mp3|ogg|wav)(\?|$)/i.test(url.pathname)) return;

  // Navigation requests (HTML documents): network-first so server-side redirects
  // (e.g. / → /setup on first install) are never bypassed by cache.
  // Offline fallback: try exact URL, then path.html, then /index.html as app shell.
  if (request.mode === 'navigate') {
    e.respondWith(
      fetch(request).catch(async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        if (url.pathname !== '/') {
          const withHtml = await caches.match(url.pathname + '.html');
          if (withHtml) return withHtml;
        }
        const index = await caches.match('/index.html');
        if (index) return index;
        // Cache completely empty (e.g. first offline open before any online visit)
        return new Response(
          '<!DOCTYPE html><html lang="de"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AeroScore – Offline</title><style>body{font-family:sans-serif;background:#0a1628;color:#e8f1ff;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center;gap:16px}h1{font-size:24px;margin:0}p{color:#7a9cc4;margin:0;max-width:300px}button{background:#4da6ff;color:#fff;border:none;padding:12px 24px;border-radius:8px;font-size:16px;cursor:pointer}</style></head><body><h1>✈ AeroScore</h1><p>App offline nicht verfügbar. Bitte zuerst einmal online öffnen, damit die App gespeichert werden kann.</p><button onclick="location.reload()">Erneut versuchen</button></body></html>',
          { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
        );
      })
    );
    return;
  }

  // SSE endpoint: never cache (infinite stream would exhaust memory)
  if (url.pathname === '/api/events') return;

  // Auth endpoints: never cache — session state changes frequently and
  // a stale cached response would incorrectly invalidate valid sessions.
  if (url.pathname.startsWith('/api/auth/')) return;

  // API GETs: network-first, cache fallback (for offline viewing)
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(
      fetch(request)
        .then(r => {
          if (r.ok) {
            const clone = r.clone();
            caches.open(CACHE).then(c => c.put(request, clone));
          }
          return r;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  // Static assets: stale-while-revalidate
  // Serve from cache immediately; update cache in background
  e.respondWith(
    caches.open(CACHE).then(async cache => {
      const cached = await cache.match(request);
      const networkFetch = fetch(request).then(r => {
        if (r.ok) cache.put(request, r.clone());
        return r;
      }).catch(() => null);
      return cached || networkFetch;
    })
  );
});
