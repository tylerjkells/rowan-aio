// Rowan's app shell, kept for offline starts. Only this site's own files are
// cached; nothing from the sync hub ever is (the app keeps its own small copy
// of what it last showed).
const CACHE = 'rowan-shell'

self.addEventListener('install', () => self.skipWaiting())

self.addEventListener('activate', (event) => {
  // a new version: start the shell cache over so old builds don't pile up
  event.waitUntil(caches.delete(CACHE).then(() => self.clients.claim()))
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  const url = new URL(req.url)
  if (req.method !== 'GET' || url.origin !== self.location.origin) return
  // only the app's own files: anything else (a hub on this same address,
  // for one) goes straight to the network, never to the cache
  const scope = new URL(self.registration.scope).pathname
  const rel = url.pathname.startsWith(scope) ? url.pathname.slice(scope.length) : null
  const shell = rel !== null && (rel.startsWith('assets/') || rel.startsWith('icons/') || rel === 'manifest.webmanifest')
  if (req.mode !== 'navigate' && !shell) return

  if (req.mode === 'navigate') {
    // the page itself: fresh when online, the last copy when not
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone()
          caches.open(CACHE).then((c) => c.put('./', copy))
          return res
        })
        .catch(() => caches.match('./').then((hit) => hit || Response.error()))
    )
    return
  }

  // scripts, styles, icons: their names change with every build, so keep them
  event.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok) {
            const copy = res.clone()
            caches.open(CACHE).then((c) => c.put(req, copy))
          }
          return res
        })
    )
  )
})
