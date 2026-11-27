/* 保守 Service Worker：HTML 网络优先（避免陈旧代码），静态资源缓存优先。 */
const CACHE = 'bio-tracker-v1';
/* 注意：CSS 目前仍内嵌在 index.html，未拆出 styles.css，故不列入预缓存。 */
const ASSETS = [
  './js/core/util.js', './js/core/bus.js', './js/core/store.js',
  './js/core/sync.js', './js/ai/guard.js', './js/schedule/bridge.js',
  './icon.svg', './manifest.webmanifest'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  // 跨源请求（外部日程站、AI、云函数）一律直通
  if (url.origin !== location.origin) return;
  // HTML 网络优先：保证更新即时生效
  if (e.request.mode === 'navigate' || url.pathname.endsWith('.html')) {
    e.respondWith(fetch(e.request).catch(() => caches.match('./index.html')));
    return;
  }
  // 静态资源缓存优先
  e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
    return res;
  })));
});
