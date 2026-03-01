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
// kick.com のタブ内で fetch を実行する（同一オリジンなので Cookie が確実に使われる）
async function syncFollowedChannels() {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://kick.com/*' });
    if (tabs.length === 0) {
      return { error: 'kick.com をタブで開いてログインした状態で再試行してください' };
    }

    // kick.com ページのコンテキストで非同期スクリプトを実行
    // 同一オリジンなので Cookie が自動付与される
    const results = await chrome.scripting.executeScript({
      target: { tabId: tabs[0].id },
      func: async () => {
        const isJson = (res) =>
          (res.headers.get('content-type') || '').includes('application/json');

        // ユーザーIDを取得（複数エンドポイントを試す）
        let userId = null;
        for (const path of ['/api/v1/user', '/api/v2/user', '/api/v2/user/me']) {
          try {
            const res = await fetch(path, {
              credentials: 'include',
              headers: { Accept: 'application/json' },
            });
            if (!res.ok || !isJson(res)) continue;
            const data = await res.json();
            userId = data?.id ?? data?.data?.id ?? data?.user?.id ?? null;
            if (userId) break;
          } catch {}
        }

        if (!userId) return { error: 'no_user' };

        // フォロー済みチャンネルを全ページ取得
        const usernames = [];
        let cursor = null;
        do {
          try {
            let url = `/api/v2/channels/followed?user_id=${userId}`;
            if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;
            const res = await fetch(url, {
              credentials: 'include',
              headers: { Accept: 'application/json' },
            });
            if (!res.ok || !isJson(res)) break;
            const data = await res.json();
            const channels = Array.isArray(data)
              ? data
              : data.data || data.channels || [];
            for (const ch of channels) {
              const name = ch.slug || ch.channel_slug || ch.username;
              if (name) usernames.push(name.toLowerCase());
            }
            cursor = data.next_cursor || data.cursor || null;
          } catch {
            break;
          }
        } while (cursor);

        return { usernames };
      },
    });

    const pageResult = results?.[0]?.result;
    if (!pageResult || pageResult.error === 'no_user') {
      return {
        error:
          'ユーザー情報を取得できませんでした。kick.com にログインしているか確認してください',
      };
    }

    const followedUsernames = pageResult.usernames || [];
    if (followedUsernames.length === 0) {
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
