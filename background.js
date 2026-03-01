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

// フォロー中チャンネルを取得してストレージに保存
// Service Workerからの fetch は host_permissions により CORS をバイパスできる
async function syncFollowedChannels() {
  try {
    // ログイン中セッションで自分のユーザー情報を取得
    const meRes = await fetch('https://kick.com/api/v2/user', {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });

    if (meRes.status === 401 || meRes.status === 403) {
      return { error: 'kick.com にログインしてから同期してください' };
    }
    if (!meRes.ok) {
      return { error: `ユーザー情報の取得に失敗しました (HTTP ${meRes.status})` };
    }

    const me = await meRes.json();
    const userId = me.id;
    if (!userId) {
      return { error: 'ユーザーIDを取得できませんでした' };
    }

    // フォロー中チャンネルを全ページ取得
    const followedUsernames = await fetchAllFollowedChannels(userId);
    if (followedUsernames.length === 0) {
      return { error: 'フォロー中のチャンネルが見つかりませんでした' };
    }

    // 既存リストにマージ（重複なし）
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

// 全ページのフォロー中チャンネルを取得（ページネーション対応）
async function fetchAllFollowedChannels(userId) {
  const usernames = [];
  let cursor = null;

  do {
    const url = new URL('https://kick.com/api/v2/channels/followed');
    url.searchParams.set('user_id', userId);
    if (cursor) url.searchParams.set('cursor', cursor);

    const res = await fetch(url.toString(), {
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });

    if (!res.ok) break;

    const data = await res.json();
    const channels = Array.isArray(data) ? data : (data.data || data.channels || []);

    for (const ch of channels) {
      const name = ch.slug || ch.channel_slug || ch.username;
      if (name) usernames.push(name.toLowerCase());
    }

    cursor = data.next_cursor || data.cursor || null;
  } while (cursor);

  return usernames;
}
