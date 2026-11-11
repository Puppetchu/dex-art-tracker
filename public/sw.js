// Dex Art Tracker service worker: makes the page installable and usable offline with what was loaded last.
// - Pages (with app.js and app.css), card data, names and ticks: network first, the last copy when offline.
// - Stored card pictures and set logos (/img/, versioned with ?v=) and the app icons: from the cache first.
// - OpenCV for the video scan (/vendor/opencv.js, about 11 MB): downloaded once, then from its own cache.
// - Everything else (logins, saving, scanning): always the network, never cached.
const VERSION = 'dex-v1';
const SHELL = VERSION + '-shell', PICS = VERSION + '-pics';
const MAX_PICS = 4000;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => !k.startsWith(VERSION)).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

function networkFirst(req) {
  return fetch(req).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(SHELL).then(c => c.put(req, copy)); }
    return res;
  }).catch(() => caches.match(req).then(r => r || Promise.reject(new Error('offline'))));
}
async function trimPics() {
  const c = await caches.open(PICS), keys = await c.keys();
  for (let i = 0; i < keys.length - MAX_PICS; i++) await c.delete(keys[i]);
}
function cacheFirst(req) {
  return caches.match(req).then(hit => hit || fetch(req).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(PICS).then(c => c.put(req, copy)).then(trimPics); }
    return res;
  }));
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const u = new URL(req.url);
  if (u.origin !== self.location.origin) return; // outside picture sites: the browser handles those itself
  const p = u.pathname;
  if (/\/vendor\/opencv\.js$/.test(p)) return e.respondWith(caches.open(VERSION + '-lib').then(c => c.match(req).then(hit => hit || fetch(req).then(res => { if (res.ok) c.put(req, res.clone()); return res; })))); // the video scan's OpenCV: downloaded once
  if (/\/img\/[cs]\//.test(p) || /\/icons\//.test(p)) return e.respondWith(cacheFirst(req));
  if (req.mode === 'navigate' || /\/data\/(cards|names)\.json$/.test(p) || /\/api\/(state|trades|accounts)$/.test(p) || /\/manifest\.webmanifest$/.test(p) || /\/(app\.js|app\.css|cardfind\.js)$/.test(p))
    return e.respondWith(networkFirst(req));
});
