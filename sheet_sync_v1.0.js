/**
 * 소소한 일상 (Family Calendar) - 구글 시트 실시간 동기화 모듈
 * 파일명: sheet_sync_v0.8.3.js
 * 변경 이력 (v0.8.3):
 *   1. 자동 동기화 새로고침 시 0ms 배경 커튼(html::after) 적용으로 암호창 깜빡임 완전 제거
 *   2. 잠금(PIN) 화면이 떠 있는 동안 자동 동기화·새로고침 전면 차단 (시크릿창/신규기기 무단 통과 방지)
 *   3. 로그인/잠금 관련 상태 키를 기기별 로컬 전용으로 분리 (서버 동기화 제외)
 *   4. 사용자가 수동으로 PIN을 입력해 잠금을 푸는 즉시 최신 일정 자동 동기화 실행
 *   5. 기존 기능 유지 (다크/라이트 기기별 독립 유지, 알림 읽음 처리 숫자 배지 제거)
 *
 * 연결 방식: family_calendar_v0.8.3.html 의 </head> 바로 위에 1줄 추가
 *   <script src="./sheet_sync_v0.8.3.js"></script>
 */
(function () {
  'use strict';

  const SYNC_VERSION = 'v0.8.3';
  const WEB_APP_URL =
    'https://script.google.com/macros/s/AKfycbzKk_1G0lruKGcS72mPiSAKRQoA5mOViDSq8bLLPdeHMGownmWMX-cHLAmDmBdUy4oV5Q/exec';

  const POLL_INTERVAL_MS = 30000; // 30초마다 자동 확인
  const SAVE_DEBOUNCE_MS = 1200;  // 연속 입력 시 1.2초 뒤 묶음 저장

  // 기기별 로컬 전용으로 유지할 키 목록 (테마 및 로그인/잠금 상태는 절대 가족 간 공유 안 함)
  const LOCAL_ONLY_KEYS = [
    'theme',
    'darkMode',
    'isDark',
    'colorMode',
    'colorScheme',
    'uiTheme',
    'isUnlocked',
    'unlocked',
    'isLoggedIn',
    'loggedIn',
    'authenticated',
    'isAuthenticated',
    'pinVerified',
    'sessionUnlocked',
    'autoUnlocked'
  ];

  const META_KEYS = {
    detectedKey: 'soso_sync_v08_detected_key',
    lastUpdated: 'soso_sync_v08_last_updated',
    lastEditor: 'soso_sync_v08_last_editor',
    serverPin: 'soso_sync_v08_server_pin',
    deviceEditor: 'soso_sync_v08_device_editor',
    autoPoll: 'soso_sync_v08_auto_poll',
    fpMap: 'soso_sync_v08_media_fp_map',
    localPrefs: 'soso_sync_v08_local_theme',
    readLogKeys: 'soso_sync_v08_read_log_keys'
  };

  const SESSION_KEYS = {
    skipPinOnce: 'soso_sync_v083_skip_pin_once',
    savedScrollY: 'soso_sync_v083_scroll_y',
    curtainBg: 'soso_sync_v083_curtain_bg'
  };

  const EXPLICIT_LOCK_SELECTORS =
    '#lock-screen, #pin-screen, #pin-lock-screen, #pin-overlay, #lock-overlay, #pin-gate, #auth-screen, #login-screen, #pin-lock-overlay';

  // 브라우저 원본 localStorage 함수 보존
  const origGetItem = Storage.prototype.getItem.bind(window.localStorage);
  const origSetItem = Storage.prototype.setItem.bind(window.localStorage);

  // [핵심 1] 동기화 직후 새로고침이라면 body가 그려지기도 전에 0ms 배경 커튼으로 화면 전체를 가림
  let isSilentReloadBoot = false;
  try {
    if (window.sessionStorage.getItem(SESSION_KEYS.skipPinOnce) === '1') {
      isSilentReloadBoot = true;
      const savedBg = window.sessionStorage.getItem(SESSION_KEYS.curtainBg) || '#0f172a';
      const curtain = document.createElement('style');
      curtain.id = 'soso-silent-curtain';
      curtain.textContent =
        'html::after{content:"";position:fixed;inset:0;z-index:2147483647;background:' +
        savedBg +
        ';pointer-events:auto;}';
      (document.head || document.documentElement).appendChild(curtain);
    }
  } catch (_) {}

  // 탭별 메모리 상태
  let detectedStateKey = origGetItem(META_KEYS.detectedKey) || '';
  let loadedLastUpdated = origGetItem(META_KEYS.lastUpdated) || '';
  let lastCheckedIso = '';
  let lastSyncableSignature = '';

  const candidateReadKeys = new Set();
  const memoryRefToDataUrl = Object.create(null);
  let saveTimer = null;
  let pollTimer = null;
  let lockWatchTimer = null;
  let isSyncing = false;
  let pendingServerReload = false;
  let lastQuickPullAt = 0;
  let isUpdatingBadge = false;
  let badgeSyncTimer = null;

  /* ==================== 1. 기기 전용 설정(테마·인증) 분리 유틸 ==================== */

  function extractLocalPrefsSnapshot(state) {
    const snap = { root: {}, settings: {} };
    if (!state || typeof state !== 'object') return snap;

    LOCAL_ONLY_KEYS.forEach(function (k) {
      if (state[k] !== undefined) snap.root[k] = state[k];
      if (state.settings && typeof state.settings === 'object' && state.settings[k] !== undefined) {
        snap.settings[k] = state.settings[k];
      }
    });
    return snap;
  }

  function hasLocalPrefValues(snap) {
    return (
      snap &&
      ((snap.root && Object.keys(snap.root).length > 0) ||
        (snap.settings && Object.keys(snap.settings).length > 0))
    );
  }

  function saveLocalPrefsSnapshot(state) {
    const snap = extractLocalPrefsSnapshot(state);
    if (hasLocalPrefValues(snap)) {
      try {
        origSetItem(META_KEYS.localPrefs, JSON.stringify(snap));
      } catch (_) {}
    }
  }

  function loadLocalPrefsSnapshot(currentLocalState) {
    const fromState = extractLocalPrefsSnapshot(currentLocalState);
    if (hasLocalPrefValues(fromState)) return fromState;
    try {
      const saved = JSON.parse(origGetItem(META_KEYS.localPrefs) || 'null');
      if (hasLocalPrefValues(saved)) return saved;
    } catch (_) {}
    return { root: {}, settings: {} };
  }

  function stripLocalOnlyFields(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    LOCAL_ONLY_KEYS.forEach(function (k) {
      if (k in obj) delete obj[k];
      if (obj.settings && typeof obj.settings === 'object' && k in obj.settings) {
        delete obj.settings[k];
      }
    });
    return obj;
  }

  function applyLocalPrefsToState(targetState, prefSnap) {
    if (!targetState || typeof targetState !== 'object') return targetState;
    stripLocalOnlyFields(targetState);

    if (prefSnap && prefSnap.root) {
      Object.keys(prefSnap.root).forEach(function (k) {
        targetState[k] = prefSnap.root[k];
      });
    }
    if (prefSnap && prefSnap.settings && Object.keys(prefSnap.settings).length > 0) {
      targetState.settings = Object.assign({}, targetState.settings || {});
      Object.keys(prefSnap.settings).forEach(function (k) {
        targetState.settings[k] = prefSnap.settings[k];
      });
    }
    return targetState;
  }

  function computeSyncableSignature(stateObj) {
    try {
      const clone = JSON.parse(JSON.stringify(stateObj));
      stripLocalOnlyFields(clone);
      return JSON.stringify(clone);
    } catch (_) {
      return '';
    }
  }

  /* ==================== 2. 기존 앱 저장소 자동 감지 훅 ==================== */

  function isSyncMetaKey(key) {
    return typeof key === 'string' && key.indexOf('soso_sync_') === 0;
  }

  function looksLikeCalendarState(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
    return Array.isArray(obj.events) && Array.isArray(obj.members);
  }

  Storage.prototype.getItem = function (key) {
    if (this === window.localStorage && typeof key === 'string' && !isSyncMetaKey(key)) {
      if (/(soso|family|calendar|state|data|db)/i.test(key)) {
        candidateReadKeys.add(key);
      }
    }
    return origGetItem(key);
  };

  Storage.prototype.setItem = function (key, value) {
    origSetItem(key, value);

    if (this !== window.localStorage || typeof key !== 'string' || isSyncMetaKey(key)) {
      return;
    }

    if (typeof value === 'string' && value.length > 20 && value.charAt(0) === '{') {
      try {
        const parsed = JSON.parse(value);
        if (looksLikeCalendarState(parsed)) {
          if (detectedStateKey !== key) {
            detectedStateKey = key;
            origSetItem(META_KEYS.detectedKey, key);
          }

          saveLocalPrefsSnapshot(parsed);
          scheduleBadgeSync();

          // 잠금 화면 상태에서는 초기 시드 데이터 등을 서버로 덮어쓰지 않도록 차단
          if (isLockScreenActive()) {
            return;
          }

          const newSig = computeSyncableSignature(parsed);
          if (lastSyncableSignature && newSig === lastSyncableSignature) {
            return;
          }
          lastSyncableSignature = newSig;
          schedulePushToServer('일정/설정 변경');
        }
      } catch (_) {}
    }
  };

  function resolveStateKey() {
    if (detectedStateKey) return detectedStateKey;

    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (!k || isSyncMetaKey(k)) continue;
      const raw = origGetItem(k);
      if (!raw || raw.charAt(0) !== '{') continue;
      try {
        const parsed = JSON.parse(raw);
        if (looksLikeCalendarState(parsed)) {
          detectedStateKey = k;
          origSetItem(META_KEYS.detectedKey, k);
          return k;
        }
      } catch (_) {}
    }

    if (candidateReadKeys.size > 0) {
      const firstKey = Array.from(candidateReadKeys)[0];
      detectedStateKey = firstKey;
      origSetItem(META_KEYS.detectedKey, firstKey);
      return firstKey;
    }

    return '';
  }

  function readLocalState() {
    const key = resolveStateKey();
    if (!key) return null;
    const raw = origGetItem(key);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      return looksLikeCalendarState(parsed) ? parsed : null;
    } catch (_) {
      return null;
    }
  }

  function writeLocalStateSilent(stateObj) {
    const key = resolveStateKey();
    if (!key) return false;
    try {
      origSetItem(key, JSON.stringify(stateObj));
      lastSyncableSignature = computeSyncableSignature(stateObj);
      return true;
    } catch (err) {
      updatePill('warn', '저장공간 부족');
      console.error('[소소한일상 동기화] 로컬 저장 실패:', err);
      return false;
    }
  }

  /* ==================== 3. 정밀 잠금(PIN) 감지 & 무깜빡임 커튼 복귀 ==================== */

  function isElementDisplayed(el) {
    if (!el || !el.isConnected) return false;
    if (el.classList && el.classList.contains('hidden')) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function findLockScreenElement() {
    // 1) 명시적 잠금 화면 ID 우선 탐색
    const directList = document.querySelectorAll(EXPLICIT_LOCK_SELECTORS);
    for (let i = 0; i < directList.length; i++) {
      const el = directList[i];
      if (el.id === 'soso-sync-modal' || el.closest('#soso-sync-modal')) continue;
      if (isElementDisplayed(el)) return el;
    }

    // 2) 전체 화면을 덮는 고정(fixed) 잠금 오버레이 탐색
    const vw = window.innerWidth || 360;
    const vh = window.innerHeight || 640;
    const candidates = document.querySelectorAll('div, section, aside');
    for (let i = 0; i < candidates.length; i++) {
      const el = candidates[i];
      if (el.id === 'soso-sync-modal' || el.closest('#soso-sync-modal')) continue;
      if (!isElementDisplayed(el)) continue;

      const style = window.getComputedStyle(el);
      if (style.position !== 'fixed') continue;

      const rect = el.getBoundingClientRect();
      if (rect.width < vw * 0.65 || rect.height < vh * 0.55) continue;

      const idCls = ((el.id || '') + ' ' + (el.className || '')).toLowerCase();
      const txt = el.textContent || '';
      const btnCount = el.querySelectorAll('button').length;
      const hasKeypadOrPass = btnCount >= 10 || !!el.querySelector('input[type="password"]');

      if (
        hasKeypadOrPass &&
        (/(비밀번호|암호|pin|잠금)/i.test(txt) || /(lock|pin|auth|passcode)/i.test(idCls))
      ) {
        return el;
      }
    }

    return null;
  }

  function isLockScreenActive() {
    return !!findLockScreenElement();
  }

  function updatePillVisibilityForLock() {
    const pill = document.getElementById('soso-sync-pill');
    if (!pill) return;
    pill.style.display = isLockScreenActive() ? 'none' : 'flex';
  }

  function reloadWithoutPinPrompt() {
    // 보안: 잠금 화면이 떠 있는 상태에서는 절대 자동 통과 플래그를 찍지 않음
    if (isLockScreenActive()) {
      return;
    }

    try {
      const bodyBg = window.getComputedStyle(document.body).backgroundColor;
      const htmlBg = window.getComputedStyle(document.documentElement).backgroundColor;
      const chosenBg =
        bodyBg && bodyBg !== 'rgba(0, 0, 0, 0)' && bodyBg !== 'transparent'
          ? bodyBg
          : htmlBg && htmlBg !== 'rgba(0, 0, 0, 0)' && htmlBg !== 'transparent'
          ? htmlBg
          : '#0f172a';

      window.sessionStorage.setItem(SESSION_KEYS.skipPinOnce, '1');
      window.sessionStorage.setItem(SESSION_KEYS.curtainBg, chosenBg);
      window.sessionStorage.setItem(SESSION_KEYS.savedScrollY, String(window.scrollY || 0));
    } catch (_) {}

    window.location.reload();
  }

  function removeSilentCurtain() {
    const curtain = document.getElementById('soso-silent-curtain');
    if (curtain) curtain.remove();

    try {
      window.sessionStorage.removeItem(SESSION_KEYS.skipPinOnce);
      window.sessionStorage.removeItem(SESSION_KEYS.curtainBg);
      const savedY = parseInt(window.sessionStorage.getItem(SESSION_KEYS.savedScrollY) || '0', 10);
      window.sessionStorage.removeItem(SESSION_KEYS.savedScrollY);
      if (!isNaN(savedY) && savedY > 0) {
        window.scrollTo(0, savedY);
      }
    } catch (_) {}

    updatePillVisibilityForLock();
  }

  function triggerProgrammaticUnlock(lockEl) {
    if (!lockEl) return;
    const pin = getServerPin();

    // 1) 숫자 키패드 버튼이 있으면 실제 앱의 정상 잠금 해제 로직 실행
    const buttons = Array.from(lockEl.querySelectorAll('button'));
    const digitBtnMap = {};
    buttons.forEach(function (btn) {
      const label = (btn.textContent || '').trim();
      if (/^[0-9]$/.test(label) && !digitBtnMap[label]) {
        digitBtnMap[label] = btn;
      }
    });

    const pinDigits = String(pin).split('');
    const hasAllDigits =
      pinDigits.length === 4 &&
      pinDigits.every(function (d) {
        return !!digitBtnMap[d];
      });

    if (hasAllDigits) {
      pinDigits.forEach(function (d) {
        digitBtnMap[d].click();
      });
    } else {
      const pinInput = lockEl.querySelector('input[type="password"], input[inputmode="numeric"], input');
      if (pinInput) {
        pinInput.value = pin;
        pinInput.dispatchEvent(new Event('input', { bubbles: true }));
        pinInput.dispatchEvent(new Event('change', { bubbles: true }));
        const confirmBtn = buttons.find(function (b) {
          return /(확인|열기|접속|로그인)/i.test((b.textContent || '').trim());
        });
        if (confirmBtn) confirmBtn.click();
      }
    }
  }

  function runSilentBootSequence() {
    if (!isSilentReloadBoot) return;
    isSilentReloadBoot = false;

    // 안전장치: 어떤 상황에서도 1.8초 이내에 커튼 강제 해제
    const failsafeTimer = setTimeout(removeSilentCurtain, 1800);
    let attempts = 0;

    function stepCheck() {
      attempts++;
      const lockEl = findLockScreenElement();

      if (lockEl) {
        if (attempts === 1) {
          triggerProgrammaticUnlock(lockEl);
        } else if (attempts >= 4) {
          // 4회차에도 남아있으면 앱 함수 또는 직접 숨김 폴백
          if (typeof window.unlockApp === 'function') {
            try {
              window.unlockApp();
            } catch (_) {}
          }
          if (isElementDisplayed(lockEl)) {
            lockEl.classList.add('hidden');
            lockEl.style.display = 'none';
          }
        }
      }

      // 잠금창이 완전히 사라지고 스타일이 안정되면 커튼 제거
      if (!findLockScreenElement() && (document.readyState === 'complete' || attempts >= 5)) {
        clearTimeout(failsafeTimer);
        setTimeout(removeSilentCurtain, 60);
        return;
      }

      if (attempts < 15) {
        setTimeout(stepCheck, 70);
      } else {
        clearTimeout(failsafeTimer);
        removeSilentCurtain();
      }
    }

    setTimeout(stepCheck, 40);
  }

  // [핵심 2] 잠금 상태일 때는 동기화를 보류하고, 사용자가 직접 암호를 푸는 순간 즉시 동기화 시작
  function startLockScreenWatcher() {
    if (lockWatchTimer) clearInterval(lockWatchTimer);
    let wasLocked = isLockScreenActive();
    updatePillVisibilityForLock();

    lockWatchTimer = setInterval(function () {
      const nowLocked = isLockScreenActive();
      updatePillVisibilityForLock();

      if (wasLocked && !nowLocked) {
        // 방금 사용자가 암호를 입력해 잠금을 풀었음 -> 즉시 최신 일정 동기화!
        wasLocked = false;
        setTimeout(function () {
          pullFromServer({ silent: false });
        }, 250);
      } else if (!wasLocked && nowLocked) {
        wasLocked = true;
      }
    }, 300);
  }

  /* ==================== 4. 알림(🔔) 미확인 숫자 배지 기기별 읽음 처리 ==================== */

  function getLogsFromState(state) {
    if (!state || typeof state !== 'object') return [];
    if (Array.isArray(state.logs)) return state.logs;
    if (Array.isArray(state.changeLogs)) return state.changeLogs;
    return [];
  }

  function getLogItemKey(item) {
    if (typeof item === 'string') return item;
    if (!item || typeof item !== 'object') return String(item || '');
    const id = item.id || '';
    const t = item.time || item.timestamp || item.createdAt || item.date || '';
    const msg = item.text || item.message || item.msg || item.action || item.detail || '';
    const key = [id, t, msg].filter(Boolean).join('|');
    return key || JSON.stringify(item);
  }

  function loadReadLogSet() {
    try {
      const arr = JSON.parse(origGetItem(META_KEYS.readLogKeys) || '[]');
      return new Set(Array.isArray(arr) ? arr : []);
    } catch (_) {
      return new Set();
    }
  }

  function saveReadLogSet(setObj) {
    try {
      const arr = Array.from(setObj);
      const trimmed = arr.length > 250 ? arr.slice(arr.length - 250) : arr;
      origSetItem(META_KEYS.readLogKeys, JSON.stringify(trimmed));
    } catch (_) {}
  }

  function findNotifButtonAndBadge() {
    const buttons = document.querySelectorAll('header button, nav button, button');
    let bellBtn = null;

    for (let i = 0; i < buttons.length; i++) {
      const btn = buttons[i];
      if (btn.closest('#soso-sync-modal') || btn.id === 'soso-sync-pill') continue;
      const idClass = (btn.id + ' ' + (btn.getAttribute('aria-label') || '') + ' ' + (btn.title || '')).toLowerCase();
      const txt = btn.textContent || '';
      if (
        txt.indexOf('🔔') !== -1 ||
        /(log|notif|alert|bell)/i.test(idClass) ||
        /알림|변경\s*기록|로그/.test(btn.title || btn.getAttribute('aria-label') || '')
      ) {
        bellBtn = btn;
        break;
      }
    }

    if (!bellBtn) return { button: null, badge: null };

    let badge =
      bellBtn.querySelector('[id*="badge"], [id*="count"], [class*="badge"]') ||
      document.querySelector('#log-badge, #logs-badge, #notif-badge, #alert-badge, #bell-badge');

    if (!badge) {
      const spans = bellBtn.querySelectorAll('span');
      for (let j = 0; j < spans.length; j++) {
        const sp = spans[j];
        const t = (sp.textContent || '').trim();
        if (
          t.indexOf('🔔') === -1 &&
          (t === '' || /^\d+\+?$/.test(t) || /rounded-full|absolute/.test(sp.className || ''))
        ) {
          badge = sp;
          break;
        }
      }
    }

    return { button: bellBtn, badge: badge };
  }

  function syncNotifBadge() {
    if (isUpdatingBadge) return;
    const found = findNotifButtonAndBadge();
    if (!found.badge) return;

    const state = readLocalState();
    const logs = getLogsFromState(state);
    const readSet = loadReadLogSet();

    let unreadCount = 0;
    for (let i = 0; i < logs.length; i++) {
      if (!readSet.has(getLogItemKey(logs[i]))) {
        unreadCount++;
      }
    }

    isUpdatingBadge = true;
    try {
      if (unreadCount <= 0) {
        found.badge.textContent = '';
        found.badge.style.display = 'none';
        found.badge.classList.add('hidden');
      } else {
        found.badge.textContent = unreadCount > 99 ? '99+' : String(unreadCount);
        found.badge.classList.remove('hidden');
        found.badge.style.display = '';
      }
    } finally {
      isUpdatingBadge = false;
    }
  }

  function markAllLogsAsRead() {
    const state = readLocalState();
    const logs = getLogsFromState(state);
    const readSet = loadReadLogSet();
    logs.forEach(function (item) {
      readSet.add(getLogItemKey(item));
    });
    saveReadLogSet(readSet);
    syncNotifBadge();
  }

  function scheduleBadgeSync() {
    if (badgeSyncTimer) clearTimeout(badgeSyncTimer);
    badgeSyncTimer = setTimeout(syncNotifBadge, 60);
  }

  function setupNotifReadWatcher() {
    document.addEventListener(
      'click',
      function (e) {
        const found = findNotifButtonAndBadge();
        if (found.button && (e.target === found.button || found.button.contains(e.target))) {
          markAllLogsAsRead();
          setTimeout(syncNotifBadge, 120);
        }
      },
      true
    );

    const header = document.querySelector('header') || document.body;
    if (header && typeof MutationObserver === 'function') {
      const obs = new MutationObserver(function () {
        if (!isUpdatingBadge) scheduleBadgeSync();
      });
      obs.observe(header, { childList: true, subtree: true, characterData: true });
    }

    setTimeout(syncNotifBadge, 150);
    setTimeout(syncNotifBadge, 700);
  }

  /* ==================== 5. PIN · 작성자 · 미디어 중복 방지 ==================== */

  function extractPinFromState(state) {
    if (!state || typeof state !== 'object') return '';
    const candidates = [
      state.settings && state.settings.familyPin,
      state.settings && state.settings.pin,
      state.familyPin,
      state.pin
    ];
    for (let i = 0; i < candidates.length; i++) {
      const p = String(candidates[i] || '').trim();
      if (/^\d{4}$/.test(p)) return p;
    }
    return '';
  }

  function getServerPin() {
    const cached = String(origGetItem(META_KEYS.serverPin) || '').trim();
    if (/^\d{4}$/.test(cached)) return cached;
    const localPin = extractPinFromState(readLocalState());
    return localPin || '1234';
  }

  function setServerPin(pin) {
    if (/^\d{4}$/.test(String(pin || '').trim())) {
      origSetItem(META_KEYS.serverPin, String(pin).trim());
    }
  }

  function getDeviceEditor(state) {
    const saved = String(origGetItem(META_KEYS.deviceEditor) || '').trim();
    if (saved) return saved;

    if (state && Array.isArray(state.members)) {
      const authorId =
        (state.settings && (state.settings.currentAuthorId || state.settings.activeAuthorId)) ||
        state.currentUserId ||
        state.currentAuthorId;
      if (authorId) {
        const found = state.members.find(function (m) {
          return m && m.id === authorId;
        });
        if (found && found.name) return found.name;
      }
    }
    return '가족 구성원';
  }

  function getMediaFingerprint(dataUrl) {
    if (typeof dataUrl !== 'string') return '';
    const len = dataUrl.length;
    return len + ':' + dataUrl.slice(0, 64) + ':' + dataUrl.slice(Math.max(0, len - 64));
  }

  function loadFpMap() {
    try {
      return JSON.parse(origGetItem(META_KEYS.fpMap) || '{}') || {};
    } catch (_) {
      return {};
    }
  }

  function saveFpMap(map) {
    try {
      const keys = Object.keys(map);
      if (keys.length > 120) {
        keys.slice(0, keys.length - 120).forEach(function (k) {
          delete map[k];
        });
      }
      origSetItem(META_KEYS.fpMap, JSON.stringify(map));
    } catch (_) {}
  }

  /* ==================== 6. 서버 규격 변환 (기기 전용 값 제외 · 데이터 무손실) ==================== */

  const SERVER_SECTIONS = ['members', 'events', 'academies', 'presets', 'docs', 'logs', 'settings'];

  function packStateForServer(rawState) {
    const clone = JSON.parse(JSON.stringify(rawState));
    stripLocalOnlyFields(clone);

    const docsField = Array.isArray(clone.docs)
      ? 'docs'
      : Array.isArray(clone.documents)
      ? 'documents'
      : 'docs';
    const logsField = Array.isArray(clone.logs)
      ? 'logs'
      : Array.isArray(clone.changeLogs)
      ? 'changeLogs'
      : 'logs';

    const extraRoot = {};
    Object.keys(clone).forEach(function (k) {
      if (SERVER_SECTIONS.indexOf(k) === -1 && k !== docsField && k !== logsField) {
        extraRoot[k] = clone[k];
      }
    });

    const settingsObj = Object.assign({}, clone.settings || {});
    const localPin = extractPinFromState(clone);
    if (localPin) settingsObj.familyPin = localPin;
    settingsObj.__syncMeta = {
      docsField: docsField,
      logsField: logsField,
      extraRoot: extraRoot
    };

    const packed = {
      members: Array.isArray(clone.members) ? clone.members : [],
      events: Array.isArray(clone.events) ? clone.events : [],
      academies: Array.isArray(clone.academies) ? clone.academies : [],
      presets: Array.isArray(clone.presets) ? clone.presets : [],
      docs: Array.isArray(clone[docsField]) ? clone[docsField] : [],
      logs: Array.isArray(clone[logsField]) ? clone[logsField] : [],
      settings: settingsObj
    };

    const fpMap = loadFpMap();
    const pendingUploads = {};

    function processMediaArray(arr, prefix) {
      arr.forEach(function (item, idx) {
        if (!item || typeof item !== 'object') return;
        Object.keys(item).forEach(function (field) {
          const val = item[field];
          if (typeof val === 'string' && val.indexOf('data:') === 0 && val.length > 500) {
            const fp = getMediaFingerprint(val);
            if (fpMap[fp]) {
              item[field] = fpMap[fp];
            } else {
              const mapKey = prefix + ':' + (item.id || idx) + ':' + field;
              pendingUploads[mapKey] = { fp: fp, dataUrl: val };
            }
          }
        });
      });
    }

    processMediaArray(packed.members, 'member');
    processMediaArray(packed.docs, 'doc');

    return { packed: packed, pendingUploads: pendingUploads };
  }

  async function hydrateDriveRefsInState(serverState, pin) {
    const fpMap = loadFpMap();
    const tasks = [];

    function scanArray(arr) {
      if (!Array.isArray(arr)) return;
      arr.forEach(function (item) {
        if (!item || typeof item !== 'object') return;
        Object.keys(item).forEach(function (field) {
          const val = item[field];
          if (typeof val === 'string' && val.indexOf('gdrive://') === 0) {
            if (memoryRefToDataUrl[val]) {
              item[field] = memoryRefToDataUrl[val];
              return;
            }
            tasks.push(
              postApi({ action: 'getMedia', pin: pin, fileRef: val })
                .then(function (res) {
                  if (res && res.ok && res.dataUrl) {
                    memoryRefToDataUrl[val] = res.dataUrl;
                    fpMap[getMediaFingerprint(res.dataUrl)] = val;
                    item[field] = res.dataUrl;
                  }
                })
                .catch(function () {})
            );
          }
        });
      });
    }

    scanArray(serverState.members);
    scanArray(serverState.docs);

    if (tasks.length > 0) {
      await Promise.all(tasks);
      saveFpMap(fpMap);
    }
  }

  function unpackStateFromServer(serverState, currentLocalState) {
    const clone = JSON.parse(JSON.stringify(serverState));
    const meta = (clone.settings && clone.settings.__syncMeta) || {};
    const docsField = meta.docsField || 'docs';
    const logsField = meta.logsField || 'logs';
    const extraRoot = meta.extraRoot || {};

    if (clone.settings && clone.settings.__syncMeta) {
      delete clone.settings.__syncMeta;
    }

    const restored = Object.assign({}, extraRoot, {
      members: clone.members || [],
      events: clone.events || [],
      academies: clone.academies || [],
      presets: clone.presets || [],
      settings: clone.settings || {}
    });

    restored[docsField] = clone.docs || [];
    restored[logsField] = clone.logs || [];

    if (clone.settings && clone.settings.familyPin) {
      if ('pin' in extraRoot) restored.pin = clone.settings.familyPin;
      if ('familyPin' in extraRoot) restored.familyPin = clone.settings.familyPin;
    }

    const localPrefSnap = loadLocalPrefsSnapshot(currentLocalState);
    applyLocalPrefsToState(restored, localPrefSnap);

    return restored;
  }

  /* ==================== 7. 화면 편집 상태 판별 ==================== */

  function isActuallyVisible(el) {
    if (!el || !el.isConnected) return false;
    const style = window.getComputedStyle(el);
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.opacity === '0' ||
      style.pointerEvents === 'none'
    ) {
      return false;
    }
    const rects = el.getClientRects();
    if (!rects || rects.length === 0) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function isUserEditingNow() {
    if (isLockScreenActive()) return true;

    const active = document.activeElement;
    if (
      active &&
      (/^(INPUT|TEXTAREA|SELECT)$/i.test(active.tagName) || active.isContentEditable) &&
      isActuallyVisible(active)
    ) {
      return true;
    }

    const modals = document.querySelectorAll(
      '[role="dialog"]:not(#soso-sync-modal), [id$="-modal"]:not(#soso-sync-modal), [id$="Modal"]:not(#soso-sync-modal)'
    );
    for (let i = 0; i < modals.length; i++) {
      if (isActuallyVisible(modals[i])) {
        return true;
      }
    }

    return false;
  }

  /* ==================== 8. 구글 Apps Script 통신 ==================== */

  async function postApi(payload) {
    const response = await fetch(WEB_APP_URL, {
      method: 'POST',
      redirect: 'follow',
      headers: {
        'Content-Type': 'text/plain;charset=utf-8'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      throw new Error('HTTP ' + response.status);
    }
    return response.json();
  }

  async function pullFromServer(options) {
    const opts = options || {};
    // 보안: 암호 잠금 화면이 열려 있으면 절대 서버에서 내려받거나 새로고침하지 않음
    if (isLockScreenActive()) return;
    if (isSyncing && !opts.force) return;
    isSyncing = true;

    if (!opts.silent) updatePill('syncing', '불러오는 중...');

    try {
      const pin = getServerPin();
      const res = await postApi({
        action: 'load',
        pin: pin,
        includeDocMedia: false
      });

      lastCheckedIso = new Date().toISOString();

      if (res && res.authError) {
        updatePill('warn', 'PIN 확인 필요');
        refreshModalInfo('서버 PIN과 일치하지 않습니다. 동기화 창에서 서버 PIN을 입력해 주세요.');
        return;
      }

      if (!res || !res.ok) {
        throw new Error((res && res.error) || '서버 응답 오류');
      }

      if (!res.initialized || !res.state) {
        const localState = readLocalState();
        if (localState) {
          isSyncing = false;
          await pushToServer({ reason: '최초 초기 데이터 업로드', force: true });
          return;
        }
        updatePill('ok', '연결됨 (대기)');
        refreshModalInfo();
        return;
      }

      const currentLocalState = readLocalState();
      const serverLastUpdated = res.lastUpdated || '';
      const hasLocal = !!currentLocalState;

      if (!opts.force && hasLocal && serverLastUpdated && serverLastUpdated === loadedLastUpdated) {
        if (pendingServerReload) {
          updatePill('update', '새 일정 도착 (클릭)');
        } else {
          updatePill('ok', '동기화됨');
        }
        refreshModalInfo();
        return;
      }

      if (!opts.silent) updatePill('syncing', '일정 반영 중...');
      await hydrateDriveRefsInState(res.state, pin);
      const restored = unpackStateFromServer(res.state, currentLocalState);

      if (writeLocalStateSilent(restored)) {
        if (serverLastUpdated) {
          origSetItem(META_KEYS.lastUpdated, serverLastUpdated);
          loadedLastUpdated = serverLastUpdated;
        }
        if (res.lastEditor) origSetItem(META_KEYS.lastEditor, res.lastEditor);

        const serverPin = extractPinFromState(restored);
        if (serverPin) setServerPin(serverPin);

        if (isUserEditingNow() && !opts.force) {
          pendingServerReload = true;
          updatePill('update', '새 일정 도착 (클릭)');
          refreshModalInfo('다른 가족이 일정을 수정했습니다. 입력 창을 닫으면 반영됩니다.');
        } else {
          pendingServerReload = false;
          updatePill('ok', '반영 완료');
          reloadWithoutPinPrompt();
        }
      }
    } catch (err) {
      updatePill('error', '오프라인/오류');
      refreshModalInfo('연결 실패: ' + err.message);
      console.error('[소소한일상 동기화] 불러오기 실패:', err);
    } finally {
      isSyncing = false;
    }
  }

  function schedulePushToServer(reason) {
    if (isLockScreenActive()) return;
    if (saveTimer) clearTimeout(saveTimer);
    updatePill('syncing', '저장 대기...');
    saveTimer = setTimeout(function () {
      pushToServer({ reason: reason });
    }, SAVE_DEBOUNCE_MS);
  }

  async function pushToServer(options) {
    const opts = options || {};
    if (isLockScreenActive()) return;
    if (isSyncing && !opts.force) {
      schedulePushToServer(opts.reason || '재시도');
      return;
    }

    const rawState = readLocalState();
    if (!rawState) {
      updatePill('warn', '저장할 일정 없음');
      return;
    }

    isSyncing = true;
    updatePill('syncing', '클라우드 저장 중...');

    try {
      const serverPin = getServerPin();
      const editor = getDeviceEditor(rawState);
      const { packed, pendingUploads } = packStateForServer(rawState);

      const res = await postApi({
        action: 'save',
        pin: serverPin,
        editor: editor,
        state: packed
      });

      lastCheckedIso = new Date().toISOString();

      if (res && res.authError) {
        updatePill('warn', 'PIN 확인 필요');
        refreshModalInfo('서버 PIN이 다릅니다. 동기화 창에서 현재 서버 PIN을 맞춰 주세요.');
        return;
      }

      if (!res || !res.ok) {
        throw new Error((res && res.error) || '저장 실패');
      }

      if (res.mediaMap && typeof res.mediaMap === 'object') {
        const fpMap = loadFpMap();
        Object.keys(res.mediaMap).forEach(function (mapKey) {
          const ref = res.mediaMap[mapKey];
          const uploaded = pendingUploads[mapKey];
          if (ref && uploaded) {
            fpMap[uploaded.fp] = ref;
            memoryRefToDataUrl[ref] = uploaded.dataUrl;
          }
        });
        saveFpMap(fpMap);
      }

      const newPinInState = extractPinFromState(rawState);
      if (newPinInState && newPinInState !== serverPin) {
        setServerPin(newPinInState);
      }

      if (res.lastUpdated) {
        origSetItem(META_KEYS.lastUpdated, res.lastUpdated);
        loadedLastUpdated = res.lastUpdated;
      }
      if (res.lastEditor) origSetItem(META_KEYS.lastEditor, res.lastEditor);

      markAllLogsAsRead();

      lastSyncableSignature = computeSyncableSignature(rawState);
      updatePill('ok', '저장 완료');
      refreshModalInfo('방금 구글 시트에 안전하게 저장되었습니다.');
    } catch (err) {
      updatePill('error', '저장 실패');
      refreshModalInfo('저장 오류: ' + err.message);
      console.error('[소소한일상 동기화] 저장 실패:', err);
    } finally {
      isSyncing = false;
    }
  }

  /* ==================== 9. 플로팅 동기화 버튼 & 관리 팝업 UI ==================== */

  function formatKoreanTime(isoStr) {
    if (!isoStr) return '기록 없음';
    try {
      const d = new Date(isoStr);
      if (isNaN(d.getTime())) return isoStr;
      return d.toLocaleString('ko-KR', {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });
    } catch (_) {
      return isoStr;
    }
  }

  function updatePill(status, text) {
    const pill = document.getElementById('soso-sync-pill');
    const dot = document.getElementById('soso-sync-dot');
    const label = document.getElementById('soso-sync-label');
    if (!pill || !dot || !label) return;

    const colors = {
      ok: '#10b981',
      syncing: '#3b82f6',
      update: '#8b5cf6',
      warn: '#f59e0b',
      error: '#ef4444'
    };

    dot.style.backgroundColor = colors[status] || '#64748b';
    label.textContent = text;
    pill.dataset.status = status;
  }

  function refreshModalInfo(customMsg) {
    const timeEl = document.getElementById('soso-sync-last-time');
    const checkEl = document.getElementById('soso-sync-last-check');
    const editorEl = document.getElementById('soso-sync-last-editor');
    const msgEl = document.getElementById('soso-sync-msg');

    if (timeEl) timeEl.textContent = formatKoreanTime(origGetItem(META_KEYS.lastUpdated));
    if (checkEl) checkEl.textContent = formatKoreanTime(lastCheckedIso);
    if (editorEl) editorEl.textContent = origGetItem(META_KEYS.lastEditor) || '-';
    if (msgEl && customMsg !== undefined) msgEl.textContent = customMsg;
  }

  function injectSyncUI() {
    if (document.getElementById('soso-sync-pill')) return;

    const style = document.createElement('style');
    style.textContent =
      '#soso-sync-pill{position:fixed;right:12px;bottom:calc(76px + env(safe-area-inset-bottom, 0px));z-index:9990;' +
      'display:flex;align-items:center;gap:6px;padding:6px 11px;border-radius:999px;background:rgba(15,23,42,0.88);' +
      'color:#f8fafc;font-size:11.5px;font-weight:600;box-shadow:0 4px 14px rgba(0,0,0,0.25);' +
      'border:1px solid rgba(255,255,255,0.16);cursor:pointer;backdrop-filter:blur(8px);' +
      '-webkit-backdrop-filter:blur(8px);font-family:inherit;transition:transform .15s ease;}' +
      '#soso-sync-pill:active{transform:scale(0.95);}' +
      '#soso-sync-dot{width:8px;height:8px;border-radius:50%;background:#3b82f6;flex-shrink:0;}' +
      '#soso-sync-modal{position:fixed;inset:0;z-index:9995;display:none;align-items:center;justify-content:center;' +
      'background:rgba(0,0,0,0.58);padding:16px;backdrop-filter:blur(4px);}' +
      '#soso-sync-modal.open{display:flex;}' +
      '.soso-sync-card{width:100%;max-width:360px;background:#1e293b;color:#f1f5f9;border-radius:20px;padding:20px;' +
      'box-shadow:0 20px 45px rgba(0,0,0,0.45);border:1px solid rgba(255,255,255,0.12);font-family:inherit;}' +
      '.soso-sync-row{display:flex;justify-content:space-between;align-items:center;font-size:13px;margin:7px 0;color:#cbd5e1;}' +
      '.soso-sync-input{width:100%;box-sizing:border-box;margin-top:5px;padding:9px 11px;border-radius:10px;' +
      'border:1px solid #475569;background:#0f172a;color:#fff;font-size:14px;}' +
      '.soso-sync-btn-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:14px;}' +
      '.soso-sync-btn{padding:10px 12px;border-radius:11px;border:none;font-size:13px;font-weight:700;cursor:pointer;color:#fff;}';
    document.head.appendChild(style);

    const pill = document.createElement('button');
    pill.id = 'soso-sync-pill';
    pill.type = 'button';
    pill.innerHTML = '<span id="soso-sync-dot"></span><span id="soso-sync-label">동기화 대기...</span>';
    pill.addEventListener('click', function () {
      if (pendingServerReload) {
        pendingServerReload = false;
        reloadWithoutPinPrompt();
        return;
      }
      openSyncModal();
    });
    document.body.appendChild(pill);

    const modal = document.createElement('div');
    modal.id = 'soso-sync-modal';
    modal.innerHTML =
      '<div class="soso-sync-card">' +
      '  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">' +
      '    <strong style="font-size:16px;">☁️ 구글 시트 가족 동기화 (' + SYNC_VERSION + ')</strong>' +
      '    <button id="soso-sync-close" type="button" style="background:none;border:none;color:#94a3b8;font-size:20px;cursor:pointer;">✕</button>' +
      '  </div>' +
      '  <div class="soso-sync-row"><span>마지막 일정 변경</span><strong id="soso-sync-last-time" style="color:#fff;">-</strong></div>' +
      '  <div class="soso-sync-row"><span>마지막 자동 확인</span><strong id="soso-sync-last-check" style="color:#a7f3d0;">-</strong></div>' +
      '  <div class="soso-sync-row"><span>마지막 수정자</span><strong id="soso-sync-last-editor" style="color:#38bdf8;">-</strong></div>' +
      '  <div style="font-size:11px;color:#94a3b8;margin:4px 0 6px;">※ 다크/라이트 테마·알림 읽음·로그인 잠금은 기기별로 독립 유지됩니다.</div>' +
      '  <div id="soso-sync-msg" style="font-size:12px;color:#fbbf24;min-height:18px;margin:4px 0 8px;"></div>' +
      '  <label style="display:block;font-size:12px;color:#94a3b8;margin-top:8px;">이 기기 사용자 이름 (수정 기록 표시용)' +
      '    <input id="soso-sync-editor-input" class="soso-sync-input" type="text" placeholder="예: 아빠, 엄마, 장인어른" />' +
      '  </label>' +
      '  <label style="display:block;font-size:12px;color:#94a3b8;margin-top:10px;">구글 시트 동기화 PIN (4자리)' +
      '    <input id="soso-sync-pin-input" class="soso-sync-input" type="password" inputmode="numeric" maxlength="4" placeholder="1234" />' +
      '  </label>' +
      '  <div class="soso-sync-btn-grid">' +
      '    <button id="soso-sync-pull-btn" type="button" class="soso-sync-btn" style="background:#2563eb;">🔄 지금 불러오기</button>' +
      '    <button id="soso-sync-push-btn" type="button" class="soso-sync-btn" style="background:#059669;">☁️ 지금 업로드</button>' +
      '  </div>' +
      '  <button id="soso-sync-auto-btn" type="button" class="soso-sync-btn" style="width:100%;margin-top:8px;background:#334155;"></button>' +
      '</div>';

    modal.addEventListener('click', function (e) {
      if (e.target === modal) modal.classList.remove('open');
    });
    document.body.appendChild(modal);

    document.getElementById('soso-sync-close').addEventListener('click', function () {
      modal.classList.remove('open');
    });

    document.getElementById('soso-sync-editor-input').addEventListener('change', function (e) {
      origSetItem(META_KEYS.deviceEditor, e.target.value.trim());
    });

    document.getElementById('soso-sync-pin-input').addEventListener('change', function (e) {
      const val = e.target.value.trim();
      if (/^\d{4}$/.test(val)) {
        setServerPin(val);
        refreshModalInfo('동기화 PIN이 업데이트되었습니다.');
      }
    });

    document.getElementById('soso-sync-pull-btn').addEventListener('click', function () {
      saveModalInputs();
      pullFromServer({ force: true });
    });

    document.getElementById('soso-sync-push-btn').addEventListener('click', function () {
      saveModalInputs();
      pushToServer({ reason: '수동 업로드', force: true });
    });

    document.getElementById('soso-sync-auto-btn').addEventListener('click', function () {
      const enabled = origGetItem(META_KEYS.autoPoll) !== 'off';
      origSetItem(META_KEYS.autoPoll, enabled ? 'off' : 'on');
      updateAutoPollButton();
      setupPolling();
    });

    updateAutoPollButton();
    updatePillVisibilityForLock();
  }

  function saveModalInputs() {
    const editorInput = document.getElementById('soso-sync-editor-input');
    const pinInput = document.getElementById('soso-sync-pin-input');
    if (editorInput) origSetItem(META_KEYS.deviceEditor, editorInput.value.trim());
    if (pinInput && /^\d{4}$/.test(pinInput.value.trim())) setServerPin(pinInput.value.trim());
  }

  function updateAutoPollButton() {
    const btn = document.getElementById('soso-sync-auto-btn');
    if (!btn) return;
    const enabled = origGetItem(META_KEYS.autoPoll) !== 'off';
    btn.textContent = enabled ? '⏱️ 30초 자동 동기화: 켜짐 (ON)' : '⏱️ 30초 자동 동기화: 꺼짐 (OFF)';
  }

  function openSyncModal() {
    const modal = document.getElementById('soso-sync-modal');
    const editorInput = document.getElementById('soso-sync-editor-input');
    const pinInput = document.getElementById('soso-sync-pin-input');
    if (editorInput) editorInput.value = origGetItem(META_KEYS.deviceEditor) || '';
    if (pinInput) pinInput.value = getServerPin();
    refreshModalInfo();
    updateAutoPollButton();
    if (modal) modal.classList.add('open');
  }

  /* ==================== 10. 자동 주기 동기화 · 포커스 · 탭 간 감지 ==================== */

  function triggerQuickPull() {
    if (isLockScreenActive()) return;
    if (origGetItem(META_KEYS.autoPoll) === 'off') return;
    const now = Date.now();
    if (now - lastQuickPullAt > 5000 && !isSyncing) {
      lastQuickPullAt = now;
      pullFromServer({ silent: true });
    }
  }

  function setupPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (origGetItem(META_KEYS.autoPoll) === 'off') return;

    pollTimer = setInterval(function () {
      if (!document.hidden && !isSyncing && !isLockScreenActive()) {
        pullFromServer({ silent: true });
      }
    }, POLL_INTERVAL_MS);
  }

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) triggerQuickPull();
  });

  window.addEventListener('focus', function () {
    triggerQuickPull();
  });

  window.addEventListener('storage', function (e) {
    if (e.key && e.key === detectedStateKey && e.newValue && !isUserEditingNow()) {
      reloadWithoutPinPrompt();
    }
  });

  window.addEventListener('DOMContentLoaded', function () {
    const initialState = readLocalState();
    if (initialState) {
      saveLocalPrefsSnapshot(initialState);
      lastSyncableSignature = computeSyncableSignature(initialState);
    }

    // 동기화 직후 새로고침이면 커튼 뒤에서 잠금 해제 후 매끄럽게 화면 노출
    runSilentBootSequence();

    injectSyncUI();
    setupNotifReadWatcher();
    startLockScreenWatcher();
    setupPolling();

    // 잠금 화면이 없을 때만 초기 동기화 실행 (잠겨 있으면 잠금 해제 직후 자동 실행)
    setTimeout(function () {
      if (!isLockScreenActive()) {
        pullFromServer({ silent: false });
      }
    }, 650);
  });

  window.SosoSheetSync = {
    version: SYNC_VERSION,
    pull: function () { return pullFromServer({ force: true }); },
    push: function () { return pushToServer({ reason: '콘솔 수동 저장', force: true }); },
    markRead: markAllLogsAsRead
  };
})();