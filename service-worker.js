/* Service worker: cachea todos los assets para que la app funcione 100% offline
   una vez cargada la primera vez. Estrategia: cache-first.
   Si cambias cualquier archivo de la app, sube el numero de VERSION. */
const VERSION = "conteo-alcy-v1";
const ASSETS = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./catalogo.json",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png"
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(VERSION).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  // Solo interceptar GET de nuestro propio origen (los POST al relay pasan directo a la red)
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;

  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((hit) => {
      if (hit) return hit;
      return fetch(e.request).then((resp) => {
        // cachear al vuelo lo que se pida y no estuviera precacheado
        if (resp.ok) {
          const copia = resp.clone();
          caches.open(VERSION).then((c) => c.put(e.request, copia));
        }
        return resp;
      }).catch(() => {
        // fallback de navegacion offline
        if (e.request.mode === "navigate") return caches.match("./index.html");
      });
    })
  );
});
