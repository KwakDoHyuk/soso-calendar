/**
 * 소소한 일상 (Family Calendar) - PWA Service Worker
 * 파일명: sw_v1.0.js
 */
const CACHE_NAME = 'soso-calendar-v1.0';
const CORE_ASSETS = ['./', './index.html', './sheet_sync_v1.0.js', './manifest_v1.0.json', './icon_v1.0.svg'];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.addAll(CORE_ASSETS).catch(function () {});
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.map(function (key) {
          if (key !== CACHE_NAME) return caches.delete(key);
        })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', function (event) {
  const req = event.request;
  const url = req.url || '';

  // POST 요청 및 구글 시트/날씨 외부 API는 캐시하지 않고 실시간 직통 처리
  if (
    req.method !== 'GET' ||
    url.indexOf('script.google.com') !== -1 ||
    url.indexOf('open-meteo.com') !== -1
  ) {
    return;
  }

  // 네트워크 우선(Network-First): 온라인일 땐 항상 최신 파일 사용, 오프라인일 때만 캐시 표시
  event.respondWith(
    fetch(req)
      .then(function (res) {
        if (res && res.status === 200 && req.url.indexOf(self.location.origin) === 0) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then(function (cache) {
            cache.put(req, copy);
          });
        }
        return res;
      })
      .catch(function () {
        return caches.match(req);
      })
  );
});