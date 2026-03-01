// Kick Stream Notifier - Content Script
// kick.com のページ上で動作し、サイドバーからフォロー中チャンネルを読み取る

// システムパス（チャンネル名ではないもの）を除外するリスト
const EXCLUDED = new Set([
  'categories', 'browse', 'clips', 'subscriptions', 'settings', 'home',
  'following', 'live', 'schedule', 'about', 'dashboard', 'studio',
  'help', 'privacy', 'terms', 'contact', 'login', 'register', 'search',
  'streams', 'videos', 'chat', 'notifications', 'wallet', 'leaderboard',
  'api', 'auth', 'logout', 'signup', 'discover', 'feed', 'explore',
  'password', 'account', 'profile', 'creator', 'partners', 'en', 'ja',
]);

// background.js からのメッセージを受信
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'GET_FOLLOWED') {
    getFollowedWithRetry().then(sendResponse);
    return true; // 非同期レスポンスのため true を返す
  }
});

// リトライしながらフォロー中チャンネルを取得（Vue の遅延レンダリング対策）
async function getFollowedWithRetry() {
  for (let attempt = 0; attempt < 8; attempt++) {
    if (attempt > 0) await sleep(700);

    const channels = getFollowedFromDOM();
    if (channels.length > 0) {
      return { usernames: channels };
    }
  }
  return { usernames: [] };
}

function getFollowedFromDOM() {
  const channels = new Set();

  // 戦略1: 「フォロー中」「Following」テキストを持つ要素の近隣リンクを探す
  const byText = extractByFollowingSection();
  byText.forEach((s) => channels.add(s));
  if (channels.size > 0) return [...channels];

  // 戦略2: 左サイドバー領域（画面左端から一定幅）のリンクを抽出
  extractBySidebarPosition(channels);
  if (channels.size > 0) return [...channels];

  // 戦略3: <aside> と <nav> 内のリンクを全スキャン
  document.querySelectorAll('aside a[href], nav a[href]').forEach((a) =>
    addChannelFromAnchor(a, channels)
  );

  return [...channels];
}

// 「フォロー中」「Following」テキスト要素を起点にリンクを収集
function extractByFollowingSection() {
  const channels = new Set();
  const KEYWORDS = ['フォロー中', 'following', 'FOLLOWING', 'followed'];

  // テキストのみの末端要素を走査
  document.querySelectorAll('span, p, h2, h3, h4, div, li, button, a').forEach((el) => {
    if (el.children.length > 0) return;
    const text = el.textContent.trim().toLowerCase();
    if (!KEYWORDS.some((kw) => text === kw.toLowerCase())) return;

    // 親要素を辿ってリンクが含まれるコンテナを探す
    let node = el.parentElement;
    for (let depth = 0; depth < 10; depth++) {
      if (!node || node === document.body) break;
      const links = node.querySelectorAll('a[href]');
      if (links.length > 0) {
        links.forEach((a) => addChannelFromAnchor(a, channels));
        if (channels.size > 0) return;
      }
      node = node.parentElement;
    }
  });

  return [...channels];
}

// 画面の左端（サイドバー領域）にあるリンクを抽出
function extractBySidebarPosition(channels) {
  const vw = document.documentElement.clientWidth || window.innerWidth;
  // サイドバーは通常 240〜300px 幅、画面幅の最大 22% または 320px を閾値とする
  const sidebarRightEdge = Math.min(Math.max(vw * 0.22, 280), 380);

  document.querySelectorAll('a[href]').forEach((a) => {
    const rect = a.getBoundingClientRect();
    // 表示されていて左端寄りのリンクのみ対象
    if (rect.width > 0 && rect.height > 0 && rect.right <= sidebarRightEdge && rect.left >= 0) {
      addChannelFromAnchor(a, channels);
    }
  });
}

// アンカー要素からチャンネルスラグを抽出してセットに追加
function addChannelFromAnchor(anchor, channels) {
  const href = anchor.getAttribute('href') || '';
  // /slug または https://kick.com/slug にマッチ（サブパスなし）
  const m = href.match(/^(?:https?:\/\/kick\.com)?\/([a-zA-Z0-9_]{2,50})$/);
  if (!m) return;
  const slug = m[1].toLowerCase();
  if (!EXCLUDED.has(slug)) {
    channels.add(slug);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
