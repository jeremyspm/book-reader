/* Offline support: keep the app's own files (never the books, which live in private storage) so it opens
   with no connection. VERSION is stamped by build_site.py; a new version replaces the old cache. */
const VERSION = "book-reader-1795520421";
const FILES = ["./", "index.html", "library.js", "reader.html", "reader.js", "reader.css", "storage-source.js",
               "manifest.webmanifest", "icon-192.png", "icon-512.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
// network first (so updates arrive when online), falling back to the saved copy when offline
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET" || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(fetch(e.request).then(r => {
    if (r.ok) { const copy = r.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); }
    return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
