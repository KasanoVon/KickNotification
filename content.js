// Kick Stream Notifier - Content Script
// kick.com/following/channels のフォロー一覧を読み取り background.js に送る

const FOLLOWING_PATH = '/following/channels';
// チャンネルのスラグ（例: /toro72, /kohey-nishi）
const SLUG_RE = /^\/([a-zA-Z0-9_-]{2,50})$/;

// background.js からのメッセージを受信
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'GET_FOLLOWED') {
    waitForStableList(8000).then((usernames) => sendResponse({ usernames }));
    return true; // 非同期レスポンスのため true を返す
  }
  if (msg.type === 'RUN_AUTO_SYNC') {
    // SPA 内の遷移で /following/channels に来たとき background.js から呼ばれる
    tryAutoSync();
  }
});

function getFollowedFromDOM() {
  if (window.location.pathname !== FOLLOWING_PATH) return [];

  // フォロー中セクション。見つからなければ見出し配下のグリッドにフォールバック
  let root = document.querySelector('section[data-testid="following"]');
  if (!root) {
    const heading = [...document.querySelectorAll('h2')].find(
      (el) => el.textContent.trim() === 'フォローしているチャンネル'
    );
    root = heading?.closest('section')?.querySelector('.grid');
  }
  if (!root) return [];

  const channels = new Set();
  root.querySelectorAll('a[href]').forEach((a) => {
    const m = (a.getAttribute('href') || '').match(SLUG_RE);
    if (m) channels.add(m[1].toLowerCase());
  });
  return [...channels];
}

// 一覧の件数が落ち着くまで待ってから返す（描画途中の不完全な一覧を送らないため）
async function waitForStableList(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let prev = [];
  while (Date.now() < deadline) {
    const current = getFollowedFromDOM();
    if (current.length > 0 && current.length === prev.length) return current;
    prev = current;
    await sleep(700);
  }
  return prev;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ============================================================
// /following/channels を開いたときの自動同期
// ============================================================

let lastAutoSyncTime = 0;

function tryAutoSync() {
  if (window.location.pathname !== FOLLOWING_PATH) return;
  const now = Date.now();
  if (now - lastAutoSyncTime < 10000) return; // 10秒クールダウン
  lastAutoSyncTime = now;
  waitForStableList(30000).then((usernames) => {
    chrome.runtime.sendMessage({ type: 'AUTO_SYNC_FOLLOWS', usernames });
  });
}

tryAutoSync();
