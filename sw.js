/* SPMS offline support: the app opens even with a weak signal. Saving still needs the internet; the app says so. */
const V = 'spms-20261024090601';
const SHELL = ['./', 'index.html', 'firebase-config.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png', 'favicon-64.png'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(V).then(c => Promise.all(SHELL.map(u => c.add(new Request(u, { cache: 'reload' })).catch(() => {})))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const r = e.request; if (r.method !== 'GET') return;
  const u = new URL(r.url);
  /* live data and sign-in always go straight to Firebase */
  if (/\.googleapis\.com$/.test(u.hostname) && u.hostname !== 'fonts.googleapis.com') return;
  if (/firebaseapp\.com$|firebaseio\.com$/.test(u.hostname)) return;
  const same = u.origin === self.location.origin;
  if (same && (r.mode === 'navigate' || /\.(html|js|webmanifest)$/.test(u.pathname) || u.pathname.endsWith('/'))) {
    /* the app itself: the newest copy from the network, the saved copy when offline */
    e.respondWith(fetch(r).then(res => { if (res.ok) { const c = res.clone(); caches.open(V).then(x => x.put(r, c)); } return res; })
      .catch(() => caches.match(r).then(m => m || caches.match('index.html'))));
    return;
  }
  if (same || /^(www\.gstatic\.com|fonts\.googleapis\.com|fonts\.gstatic\.com|cdnjs\.cloudflare\.com)$/.test(u.hostname)) {
    /* icons, the Firebase library, fonts and the Excel reader: the saved copy first */
    e.respondWith(caches.match(r).then(m => m || fetch(r).then(res => { if (res.ok || res.type === 'opaque') { const c = res.clone(); caches.open(V).then(x => x.put(r, c)); } return res; })));
  }
});

/* ---------- notifications (sent by the server function in functions/ through Firebase Cloud Messaging) ---------- */
const IOS = /iPhone|iPad|iPod/.test(self.navigator.userAgent || '');
self.addEventListener('push', e => {
  let p = {}; try { p = e.data ? e.data.json() : {}; } catch (x) { p = { data: { title: 'SPMS', body: e.data ? e.data.text() : '' } }; }
  const d = Object.assign({}, p.notification || {}, p.data || {});
  const title = d.title || 'SPMS', tag = d.tag || undefined;
  const opts = { body: d.body || '', tag, renotify: !!tag && d.renotify === '1', silent: d.silent === '1', requireInteraction: d.urgent === '1',
    icon: 'icon-192.png', badge: 'badge-96.png', vibrate: d.silent === '1' ? undefined : [120, 60, 120], data: { url: d.url || './', job: d.job || '' } };
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
    const onScreen = cs.some(c => c.visibilityState === 'visible');
    cs.forEach(c => c.postMessage({ type: 'push', data: d }));
    /* SPMS is open on screen: it already shows its own alert. iPhones must always show the notification. */
    if (onScreen && !IOS) return undefined;
    return self.registration.showNotification(title, opts);
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const d = e.notification.data || {}, url = new URL(d.url || './', self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
    const c = cs.find(x => x.url.startsWith(self.registration.scope));
    if (c) { c.postMessage({ type: 'open-job', job: d.job }); return c.focus(); }
    return self.clients.openWindow(url);
  }));
});
