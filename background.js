// Kick Stream Notifier - Service Worker
// Kick APIを定期的にポーリングして配信開始を検知する

const CHECK_INTERVAL_MINUTES = 1;
const KICK_API_BASE = 'https://kick.com/api/v2/channels/';

// 拡張機能インストール時・起動時の初期化
chrome.runtime.onInstalled.addListener(() => {
  setupAlarm();
});

chrome.runtime.onStartup.addListener(() => {
  setupAlarm();
});

function setupAlarm() {
  chrome.alarms.clearAll(() => {
    chrome.alarms.create('checkStreams', { periodInMinutes: CHECK_INTERVAL_MINUTES });
  });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'checkStreams') checkAllStreams();
});

// 登録された全ストリーマーのライブ状態をチェック
async function checkAllStreams() {
  const data = await chrome.storage.local.get(['streamers', 'liveStatus']);
  const streamers = data.streamers || [];
  const previousStatus = data.liveStatus || {};

  if (streamers.length === 0) return;

  const newStatus = {};

  await Promise.all(
    streamers.map(async (username) => {
      try {
        const channelData = await fetchChannelData(username);
        if (!channelData) return;

        const isLive = channelData.livestream !== null;
        newStatus[username] = {
          isLive,
          title: channelData.livestream?.session_title || '',
          category: channelData.livestream?.categories?.[0]?.name || '',
          viewers: channelData.livestream?.viewer_count || 0,
          thumbnail: channelData.user?.profile_pic || '',
        };

        const wasLive = previousStatus[username]?.isLive || false;
        if (!wasLive && isLive) {
          sendNotification(username, newStatus[username]);
        }
      } catch (err) {
        console.error(`Failed to check ${username}:`, err);
      }
    })
  );

  await chrome.storage.local.set({ liveStatus: newStatus });
}

async function fetchChannelData(username) {
  const response = await fetch(`${KICK_API_BASE}${username}`, {
    headers: { Accept: 'application/json' },
  });

  if (!response.ok) {
    if (response.status === 404) {
      console.warn(`Channel not found: ${username}`);
      return null;
    }
    throw new Error(`HTTP ${response.status}`);
  }

  return response.json();
}

async function sendNotification(username, info) {
  const { autoJoin = false } = await chrome.storage.local.get('autoJoin');

  // 自動入場が有効なら配信ページを自動で開く
  if (autoJoin) {
    chrome.tabs.create({ url: `https://kick.com/${username}`, active: true });
  }

  const notifId = `kick-live-${username}-${Date.now()}`;
  const message = info.title
    ? `${info.title}${info.category ? ` [${info.category}]` : ''}`
    : '配信を開始しました';

  chrome.notifications.create(notifId, {
    type: 'basic',
    iconUrl: info.thumbnail || 'icons/icon128.png',
    title: `🟢 ${username} が配信開始！${autoJoin ? ' (自動入場)' : ''}`,
    message,
    contextMessage: info.viewers > 0 ? `${info.viewers.toLocaleString()} 人が視聴中` : '',
    priority: 2,
    requireInteraction: false,
  });
}

chrome.notifications.onClicked.addListener((notifId) => {
  if (notifId.startsWith('kick-live-')) {
    const parts = notifId.split('-');
    const username = parts.slice(2, -1).join('-');
    chrome.tabs.create({ url: `https://kick.com/${username}` });
    chrome.notifications.clear(notifId);
  }
});

// メッセージリスナー
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'CHECK_NOW') {
    checkAllStreams().then(() => sendResponse({ success: true }));
    return true;
  }
  if (message.type === 'SYNC_FOLLOWS') {
    syncFollowedChannels().then(sendResponse);
    return true;
  }
});

// フォロー中チャンネルを同期する
// アプローチ1: content.js (DOM scraping) に依頼
// アプローチ2: executeScript で直接 DOM を読む（content.js 未ロード時のフォールバック）
async function syncFollowedChannels() {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://kick.com/*' });
    if (tabs.length === 0) {
      return {
        error:
          'kick.com をタブで開いてログインした状態で再試行してください',
      };
    }

    const tabId = tabs[0].id;

    // アプローチ1: content.js に DOM 読み取りを依頼
    const contentResult = await askContentScript(tabId);
    if (contentResult.length > 0) {
      return await mergeAndSave(contentResult);
    }

    // アプローチ2: executeScript で DOM を直接読む（リトライあり）
    const scriptResult = await readSidebarViaScript(tabId);
    if (scriptResult.length > 0) {
      return await mergeAndSave(scriptResult);
    }

    return {
      error:
        'サイドバーからチャンネルを読み取れませんでした。\nkick.com のホーム画面を開いた状態でお試しください。',
    };
  } catch (err) {
    console.error('syncFollowedChannels error:', err);
    return { error: `エラー: ${err.message}` };
  }
}

// content.js へメッセージを送りフォロー中チャンネルを取得
function askContentScript(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: 'GET_FOLLOWED' }, (response) => {
      if (chrome.runtime.lastError) {
        console.log('content.js not ready:', chrome.runtime.lastError.message);
        resolve([]);
      } else {
        resolve(response?.usernames || []);
      }
    });
  });
}

// executeScript でサイドバー DOM を読む（content.js が動かない場合のフォールバック）
async function readSidebarViaScript(tabId) {
  const EXCLUDED_JSON = JSON.stringify([
    'categories', 'browse', 'clips', 'subscriptions', 'settings', 'home',
    'following', 'live', 'schedule', 'about', 'dashboard', 'studio',
    'help', 'privacy', 'terms', 'contact', 'login', 'register', 'search',
    'streams', 'videos', 'chat', 'notifications', 'wallet', 'leaderboard',
    'api', 'auth', 'logout', 'signup', 'discover', 'feed', 'explore',
    'password', 'account', 'profile', 'creator', 'partners', 'en', 'ja',
  ]);

  // 最大 5 回リトライ（Vue の遅延レンダリング対策）
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) await sleep(800);

    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: (excludedJson) => {
        const EXCLUDED = new Set(JSON.parse(excludedJson));
        const channels = new Set();
        const vw = document.documentElement.clientWidth || window.innerWidth;
        const sidebarRight = Math.min(Math.max(vw * 0.22, 280), 380);

        // 戦略1: 左サイドバー位置ベース
        document.querySelectorAll('a[href]').forEach((a) => {
          const rect = a.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0 && rect.right <= sidebarRight && rect.left >= 0) {
            const href = a.getAttribute('href') || '';
            const m = href.match(/^(?:https?:\/\/kick\.com)?\/([a-zA-Z0-9_]{2,50})$/);
            if (m && !EXCLUDED.has(m[1].toLowerCase())) channels.add(m[1].toLowerCase());
          }
        });

        if (channels.size > 0) return [...channels];

        // 戦略2: テキスト「フォロー中」「Following」の近隣リンク
        const KEYWORDS = ['フォロー中', 'following', 'followed'];
        document.querySelectorAll('span, p, h2, h3, h4, div, li, button').forEach((el) => {
          if (el.children.length > 0) return;
          const text = el.textContent.trim().toLowerCase();
          if (!KEYWORDS.includes(text)) return;
          let node = el.parentElement;
          for (let d = 0; d < 10; d++) {
            if (!node || node === document.body) break;
            node.querySelectorAll('a[href]').forEach((a) => {
              const href = a.getAttribute('href') || '';
              const m = href.match(/^(?:https?:\/\/kick\.com)?\/([a-zA-Z0-9_]{2,50})$/);
              if (m && !EXCLUDED.has(m[1].toLowerCase())) channels.add(m[1].toLowerCase());
            });
            if (channels.size > 0) return;
            node = node.parentElement;
          }
        });

        // 戦略3: aside / nav 全スキャン
        document.querySelectorAll('aside a[href], nav a[href]').forEach((a) => {
          const href = a.getAttribute('href') || '';
          const m = href.match(/^(?:https?:\/\/kick\.com)?\/([a-zA-Z0-9_]{2,50})$/);
          if (m && !EXCLUDED.has(m[1].toLowerCase())) channels.add(m[1].toLowerCase());
        });

        return [...channels];
      },
      args: [EXCLUDED_JSON],
    });

    const found = results?.[0]?.result || [];
    if (found.length > 0) return found;
  }

  return [];
}

async function mergeAndSave(followedUsernames) {
  const { streamers = [] } = await chrome.storage.local.get('streamers');
  const merged = [...new Set([...streamers, ...followedUsernames])];
  await chrome.storage.local.set({ streamers: merged });
  const added = merged.length - streamers.length;
  checkAllStreams();
  return { success: true, added };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
