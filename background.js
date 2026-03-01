// Kick Stream Notifier - Service Worker
// Kick APIを定期的にポーリングして配信開始を検知する

const CHECK_INTERVAL_MINUTES = 1; // チェック間隔（分）
const KICK_API_BASE = 'https://kick.com/api/v2/channels/';

// 拡張機能インストール時・起動時の初期化
chrome.runtime.onInstalled.addListener(() => {
  setupAlarm();
});

chrome.runtime.onStartup.addListener(() => {
  setupAlarm();
});

// アラームのセットアップ
function setupAlarm() {
  chrome.alarms.clearAll(() => {
    chrome.alarms.create('checkStreams', {
      periodInMinutes: CHECK_INTERVAL_MINUTES,
    });
  });
}

// アラーム発火時にストリームをチェック
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'checkStreams') {
    checkAllStreams();
  }
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

        // 前回オフラインで今回オンラインになった場合に通知
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

// Kick API からチャンネルデータを取得
async function fetchChannelData(username) {
  const response = await fetch(`${KICK_API_BASE}${username}`, {
    headers: {
      Accept: 'application/json',
    },
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

// デスクトップ通知を送信
function sendNotification(username, info) {
  const notifId = `kick-live-${username}-${Date.now()}`;
  const message = info.title
    ? `${info.title}${info.category ? ` [${info.category}]` : ''}`
    : '配信を開始しました';

  chrome.notifications.create(notifId, {
    type: 'basic',
    iconUrl: info.thumbnail || 'icons/icon128.png',
    title: `🟢 ${username} が配信開始！`,
    message,
    contextMessage: info.viewers > 0 ? `${info.viewers.toLocaleString()} 人が視聴中` : '',
    priority: 2,
    requireInteraction: false,
  });
}

// 通知クリックでチャンネルページを開く
chrome.notifications.onClicked.addListener((notifId) => {
  if (notifId.startsWith('kick-live-')) {
    const parts = notifId.split('-');
    // "kick-live-{username}-{timestamp}" の形式
    const username = parts.slice(2, -1).join('-');
    chrome.tabs.create({ url: `https://kick.com/${username}` });
    chrome.notifications.clear(notifId);
  }
});

// メッセージリスナー（popupからのリクエスト）
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

// kick.com の XSRF-TOKEN クッキーを取得する（Laravel CSRF 対策）
function getXsrfToken() {
  return new Promise((resolve) => {
    chrome.cookies.get({ url: 'https://kick.com', name: 'XSRF-TOKEN' }, (cookie) => {
      resolve(cookie ? decodeURIComponent(cookie.value) : null);
    });
  });
}

// レスポンスが JSON かチェックしてパースする
async function parseJsonResponse(res) {
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    return null; // HTML などが返ってきた場合
  }
  return res.json();
}

// フォロー中チャンネルを取得してストレージに保存
async function syncFollowedChannels() {
  try {
    const xsrfToken = await getXsrfToken();
    if (!xsrfToken) {
      return { error: 'kick.com にログインしてから同期してください' };
    }
    const headers = { Accept: 'application/json', 'X-XSRF-TOKEN': xsrfToken };

    // Step 1: user_id なしで直接フォロー済み API を試す
    let followedUsernames = await tryFollowedDirect(headers);

    // Step 2: 失敗した場合 → kick.com タブからユーザーIDを取得して再試行
    if (followedUsernames === null) {
      const userId = await getUserIdFromPage();
      if (!userId) {
        return {
          error:
            'ユーザーIDを取得できませんでした。kick.com をタブで開いてログインした状態で再試行してください',
        };
      }
      followedUsernames = await fetchAllFollowedChannels(userId, headers);
    }

    if (!followedUsernames || followedUsernames.length === 0) {
      return { error: 'フォロー中のチャンネルが見つかりませんでした' };
    }

    const { streamers = [] } = await chrome.storage.local.get('streamers');
    const merged = [...new Set([...streamers, ...followedUsernames])];
    await chrome.storage.local.set({ streamers: merged });

    const added = merged.length - streamers.length;
    checkAllStreams();
    return { success: true, added };
  } catch (err) {
    console.error('syncFollowedChannels error:', err);
    return { error: `エラー: ${err.message}` };
  }
}

// user_id なしでフォロー済みチャンネルを直接取得（セッション認証のみ）
// 成功すれば配列を返す。エンドポイントが対応していない場合は null を返す
async function tryFollowedDirect(headers) {
  const res = await fetch('https://kick.com/api/v2/channels/followed', {
    credentials: 'include',
    headers,
  });
  if (res.status === 401 || res.status === 403) return null;
  if (!res.ok) return null;

  const data = await parseJsonResponse(res);
  if (!data) return null;

  const channels = Array.isArray(data) ? data : (data.data || data.channels || []);
  // 空配列は「フォローなし」ではなく「user_id 必要」の可能性があるため null で区別
  if (channels.length === 0 && !Array.isArray(data)) return null;

  return channels
    .map((ch) => ch.slug || ch.channel_slug || ch.username)
    .filter(Boolean)
    .map((n) => n.toLowerCase());
}

// kick.com の開いているタブのページ状態からユーザーIDを取得
async function getUserIdFromPage() {
  const tabs = await chrome.tabs.query({ url: 'https://kick.com/*' });
  if (tabs.length === 0) return null;

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tabs[0].id },
      func: () => {
        // Nuxt 3 の payload からユーザー情報を探す
        try {
          const el = document.getElementById('__NUXT_DATA__');
          if (el) {
            const payload = JSON.parse(el.textContent);
            const str = JSON.stringify(payload);
            const m = str.match(/"id":(\d+),"username":/);
            if (m) return parseInt(m[1], 10);
          }
        } catch {}

        // フォールバック: グローバル変数を探す
        try {
          const app = window.__nuxt_app__ || window.__nuxt__;
          const user =
            app?.config?.globalProperties?.$auth?.user ||
            app?.payload?.data?.user ||
            app?.ssrContext?.payload?.data?.user;
          if (user?.id) return user.id;
        } catch {}

        return null;
      },
    });
    return results?.[0]?.result ?? null;
  } catch (err) {
    console.error('getUserIdFromPage error:', err);
    return null;
  }
}

// user_id を指定してフォロー済みチャンネルを全ページ取得
async function fetchAllFollowedChannels(userId, headers) {
  const usernames = [];
  let cursor = null;

  do {
    const url = new URL('https://kick.com/api/v2/channels/followed');
    url.searchParams.set('user_id', userId);
    if (cursor) url.searchParams.set('cursor', cursor);

    const res = await fetch(url.toString(), { credentials: 'include', headers });
    if (!res.ok) break;

    const data = await parseJsonResponse(res);
    if (!data) break;

    const channels = Array.isArray(data) ? data : (data.data || data.channels || []);
    for (const ch of channels) {
      const name = ch.slug || ch.channel_slug || ch.username;
      if (name) usernames.push(name.toLowerCase());
    }

    cursor = data.next_cursor || data.cursor || null;
  } while (cursor);

  return usernames;
}
