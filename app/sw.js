/* Go-Kirana Staff Console — service worker.
   Exists mainly so Chrome/Android treat the app shell as installable, and
   so it opens instantly (stale-while-revalidate) instead of blank-while-
   fetching on a slow connection. It never touches the Apps Script API
   calls (POST, cross-origin) — those always go straight to the network. */

const CACHE_NAME = 'gk-shell-v33';
const SHELL_ASSETS = [
    './',
    './index.html',
    './manifest.json',
    './assets/api.js',
    './assets/auth.js',
    './assets/theme.css',
    './views/agent.html',
    './views/agent.js',
    './views/admin.html',
    './views/admin.js',
    './views/orders.html',
    './views/orders.js'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => cache.addAll(SHELL_ASSETS))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

    event.respondWith(
        caches.match(req).then((cached) => {
            const network = fetch(req).then((res) => {
                if (res && res.ok) {
                    const copy = res.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
                }
                return res;
            }).catch(() => cached);
            return cached || network;
        })
    );
});
