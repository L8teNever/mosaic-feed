"use strict";

const CACHE_NAME = "mosaic-shell-v4";
const APP_SHELL = [
  "/",
  "/stats",
  "/discover",
  "/static/css/style.css",
  "/static/js/app.js",
  "/static/manifest.json",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  // Never cache API responses or uploaded photos - they change constantly
  // and could be large; only the app shell (HTML/CSS/JS) is worth caching.
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/static/uploads/")) {
    return;
  }

  // Network-first: an actively developed app shouldn't get stuck showing an
  // old cached version to a returning visitor just because one happened to
  // be cached. The cache only ever serves as a fallback when there's no
  // network at all.
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request))
  );
});
