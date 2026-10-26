// voseá — service worker
//
// Tier 0 PWA: just enough offline caching to make the app-shell (the HTML,
// CSS, JS, manifest, and icons) load instantly and work without a network
// connection. It deliberately does NOT try to cache or work with:
//   - Supabase API calls (auth, verbs/words/lists data) — those must always
//     hit the network so the user sees real, current data, and stale-write
//     conflicts don't happen.
//   - Google Fonts — cross-origin, and not worth the complexity here.
//
// Strategy: stale-while-revalidate for same-origin GET requests. Serve
// from cache immediately if we have it (fast, works offline), and in the
// background fetch a fresh copy to store for next time.

var CACHE_NAME = "vosea-shell-v173";

var SHELL_FILES = [
  "./",
  "./index.html",
  "./styles.css",
  "./temas.js",
  "./escenas.js",
  "./app.js",
  "./config.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
];

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      // cache.addAll() is all-or-nothing — if a single file 404s (e.g. an
      // icon that didn't get deployed), the whole install silently fails
      // and NO offline caching works, not just for that one file. Caching
      // each file independently means one missing/broken file is just
      // skipped instead of taking the rest of the app shell down with it.
      return Promise.all(
        SHELL_FILES.map(function (url) {
          // cache: "reload" skips the browser's own HTTP cache, so a new
          // version never precaches a stale copy of a file the browser
          // fetched a few minutes earlier (GitHub Pages lets browsers keep
          // files for up to 10 minutes).
          return cache.add(new Request(url, { cache: "reload" })).catch(function (err) {
            console.warn("No se pudo precachear " + url + ":", err);
          });
        })
      );
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (names) {
      return Promise.all(
        names
          .filter(function (name) { return name !== CACHE_NAME; })
          .map(function (name) { return caches.delete(name); })
      );
    }).then(function () {
      return self.clients.claim();
    })
  );
});

self.addEventListener("fetch", function (event) {
  var request = event.request;

  // Only handle same-origin GET requests — everything else (Supabase API
  // calls, Google Fonts, POST/PUT/etc.) passes straight through untouched.
  if (request.method !== "GET") return;
  var url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.match(request).then(function (cached) {
        var networkFetch = fetch(request).then(function (response) {
          if (response && response.ok) {
            cache.put(request, response.clone());
          }
          return response;
        }).catch(function () {
          // Offline and not cached — for a navigation, fall back to the
          // cached app shell so the user at least sees the app.
          if (request.mode === "navigate") {
            return cache.match("./index.html");
          }
          return cached;
        });

        return cached || networkFetch;
      });
    })
  );
});

// ---- Push notifications (2026-10-23) ----------------------------------------
// The push-send Edge Function sends Declarative Web Push JSON:
//   { web_push: 8030, notification: { title, body, lang, navigate, tag } }
// Safari 18.4+ shows that by itself; everywhere else this handler shows it.
// Tapping a notification opens (or focuses) the app at notification.navigate,
// e.g. ?open=amigos, ?open=list&id=…, ?open=retos.
self.addEventListener("push", function (event) {
  var msg = {};
  try { msg = event.data ? event.data.json() : {}; } catch (e) { msg = {}; }
  var n = msg.notification || {};
  var title = n.title || "voseá";
  event.waitUntil(self.registration.showNotification(title, {
    body: n.body || "",
    lang: n.lang || "es",
    tag: n.tag || undefined,
    icon: "./icons/icon-192.png",
    badge: "./icons/icon-192.png",
    data: { url: n.navigate || "./" },
  }));
});

self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  var target = (event.notification.data && event.notification.data.url) || "./";
  var url = new URL(target, self.registration.scope);
  if (url.origin !== self.location.origin) url = new URL("./", self.registration.scope);
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (wins) {
      for (var i = 0; i < wins.length; i++) {
        var w = wins[i];
        if (new URL(w.url).origin === url.origin) {
          // the app is open: tell it where to go, and bring it forward
          w.postMessage({ type: "vosea-open", search: url.search });
          return w.focus();
        }
      }
      return self.clients.openWindow(url.href);
    })
  );
});

// The browser replaced this device's subscription: the app sends the new one
// to the database the next time it opens (it re-registers at every start).
self.addEventListener("pushsubscriptionchange", function (event) {
  event.waitUntil(self.clients.matchAll({ type: "window" }).then(function (wins) {
    wins.forEach(function (w) { w.postMessage({ type: "vosea-push-changed" }); });
  }));
});
