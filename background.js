// Kick Stream Notifier - Service Worker
// Kick APIを定期的にポーリングして配信開始を検知する

const CHECK_INTERVAL_MINUTES = 1;
const SYNC_INTERVAL_MINUTES = 15;
const KICK_API_BASE = 'https://kick.com/api/v2/channels/';
const KICK_OAUTH_BASE = 'https://id.kick.com';
const KICK_PUBLIC_API = 'https://api.kick.com/public/v1';

// ============================================================
// OAuth 2.1 + PKCE ヘルパー
// ============================================================

function generateCodeVerifier() {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return btoa(String.fromCharCode(...array))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function generateCodeChallenge(verifier) {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

// Kick OAuth ログイン（PKCE S256）
// clientSecret は Kick がパブリッククライアントを未サポートの場合のみ必要
async function kickOAuthLogin(clientId, clientSecret) {
  const redirectUri = chrome.identity.getRedirectURL('kick');
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);
  const state = generateCodeVerifier();

  const authUrl = new URL(`${KICK_OAUTH_BASE}/oauth/authorize`);
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', 'user:read channel:read');
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');

  const responseUrl = await new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow(
      { url: authUrl.toString(), interactive: true },
      (url) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else if (!url) reject(new Error('認証がキャンセルされました'));
        else resolve(url);
      }
    );
  });

  const returnedParams = new URL(responseUrl).searchParams;
  if (returnedParams.get('state') !== state) throw new Error('State mismatch（セキュリティエラー）');
  const code = returnedParams.get('code');
  if (!code) throw new Error('認証コードが取得できませんでした');

  // トークン交換
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: clientId,
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  });
  if (clientSecret) body.set('client_secret', clientSecret);

  const tokenRes = await fetch(`${KICK_OAUTH_BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!tokenRes.ok) {
    const err = await tokenRes.text();
    throw new Error(`トークン取得失敗 (${tokenRes.status}): ${err}`);
  }

  const tokens = await tokenRes.json();

  // ユーザー情報を取得
  const userInfo = await fetchWithToken(tokens.access_token, `${KICK_PUBLIC_API}/users`);
  const user = userInfo?.data?.[0] || userInfo?.data || userInfo?.user || null;

  await chrome.storage.local.set({
    kickAccessToken: tokens.access_token,
    kickRefreshToken: tokens.refresh_token || null,
    kickTokenExpiry: Date.now() + (tokens.expires_in || 3600) * 1000,
    kickClientId: clientId,
    kickClientSecret: clientSecret || null,
    kickUser: user,
  });

  return { success: true, user };
}

// トークンの有効期限チェック & リフレッシュ
async function getValidToken() {
  const data = await chrome.storage.local.get([
    'kickAccessToken', 'kickRefreshToken', 'kickTokenExpiry',
    'kickClientId', 'kickClientSecret',
  ]);

  if (!data.kickAccessToken) return null;

  // 有効期限まで5分以上あればそのまま使用
  if (data.kickTokenExpiry && Date.now() < data.kickTokenExpiry - 5 * 60 * 1000) {
    return data.kickAccessToken;
  }

  // リフレッシュトークンで更新
  if (!data.kickRefreshToken || !data.kickClientId) return null;

  try {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: data.kickClientId,
      refresh_token: data.kickRefreshToken,
    });
    if (data.kickClientSecret) body.set('client_secret', data.kickClientSecret);

    const res = await fetch(`${KICK_OAUTH_BASE}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });

    if (!res.ok) {
      await chrome.storage.local.remove(['kickAccessToken', 'kickRefreshToken', 'kickTokenExpiry', 'kickUser']);
      return null;
    }

    const tokens = await res.json();
    await chrome.storage.local.set({
      kickAccessToken: tokens.access_token,
      kickRefreshToken: tokens.refresh_token || data.kickRefreshToken,
      kickTokenExpiry: Date.now() + (tokens.expires_in || 3600) * 1000,
    });
    return tokens.access_token;
  } catch {
    return null;
  }
}

// Bearer トークン付きで API リクエスト
async function fetchWithToken(token, url) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (!res.ok) return null;
  return res.json();
}

// フォロー中チャンネルを公式 API から取得
async function getFollowedViaOAuth() {
  const token = await getValidToken();
  if (!token) return null;

  // 試みるエンドポイント（公式APIにまだ公開されていない可能性あり）
  const candidates = [
    `${KICK_PUBLIC_API}/channels/followed`,
    `${KICK_PUBLIC_API}/users/me/following`,
    `${KICK_PUBLIC_API}/users/following`,
  ];

  for (const url of candidates) {
    const data = await fetchWithToken(token, url);
    if (!data) continue;
    const list = data.data || data.channels || data.followed || (Array.isArray(data) ? data : null);
    if (Array.isArray(list) && list.length > 0) {
      return list.map((ch) => (ch.slug || ch.broadcaster_username || ch.username || '').toLowerCase()).filter(Boolean);
    }
  }

  return null; // 公式APIでは未公開の可能性
}

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
    chrome.alarms.create('syncFollows', { periodInMinutes: SYNC_INTERVAL_MINUTES });
  });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'checkStreams') checkAllStreams();
  if (alarm.name === 'syncFollows') syncFollowedChannels();
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
          thumbnail: channelData.livestream?.thumbnail?.url || channelData.user?.profile_pic || '',
          avatar: channelData.user?.profile_pic || '',
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
  const { autoJoinStreamers = [] } = await chrome.storage.local.get('autoJoinStreamers');
  const autoJoin = autoJoinStreamers.includes(username);

  // 自動入場が有効なら配信ページを自動で開く
  if (autoJoin) {
    chrome.tabs.create({ url: `https://kick.com/${username}`, active: true });
  }

  const notifId = `kick-live-${username}-${Date.now()}`;
  const message = info.title
    ? `${info.title}${info.category ? ` [${info.category}]` : ''}`
    : '配信を開始しました';

  try {
    await chrome.notifications.create(notifId, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: `${username} が配信開始！${autoJoin ? ' (自動入場)' : ''}`,
      message,
      priority: 2,
    });
  } catch (err) {
    console.warn('Notification creation failed:', err.message);
  }
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
  if (message.type === 'AUTO_SYNC_FOLLOWS') {
    if (Array.isArray(message.usernames) && message.usernames.length > 0) {
      mergeAndSave(message.usernames);
    }
    sendResponse({ success: true });
    return true;
  }
  if (message.type === 'KICK_LOGIN') {
    kickOAuthLogin(message.clientId, message.clientSecret).then(sendResponse).catch((err) =>
      sendResponse({ error: err.message })
    );
    return true;
  }
  if (message.type === 'KICK_LOGOUT') {
    chrome.storage.local.remove([
      'kickAccessToken', 'kickRefreshToken', 'kickTokenExpiry',
      'kickClientId', 'kickClientSecret', 'kickUser',
    ]).then(() => sendResponse({ success: true }));
    return true;
  }
});

// フォロー中チャンネルを同期する
// アプローチ0: 公式 OAuth API（kick.com タブ不要）
// アプローチ1: content.js (DOM scraping) に依頼
// アプローチ2: executeScript で直接 DOM を読む（content.js 未ロード時のフォールバック）
// ※ kick.com タブが開いていない場合は自動でバックグラウンドタブを開いて取得後に閉じる
async function syncFollowedChannels() {
  try {
    // アプローチ0: OAuth トークンがあれば公式 API を試す
    const oauthResult = await getFollowedViaOAuth();
    if (oauthResult !== null && oauthResult.length > 0) {
      return await mergeAndSave(oauthResult);
    }

    // 常に /following ページのタブを使用する（他のページは不正確な結果を返すため）
    let tabs = await chrome.tabs.query({ url: 'https://kick.com/following' });
    let autoTab = null;

    if (tabs.length === 0) {
      // /following タブを自動でバックグラウンド起動
      autoTab = await chrome.tabs.create({ url: 'https://kick.com/following', active: false });
      await waitForTabLoad(autoTab.id);
      await sleep(2500); // Vue レンダリング待機
      tabs = [autoTab];
    }

    const tabId = tabs[0].id;

    try {
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
          'フォロー中チャンネルを読み取れませんでした。\nkick.com にログインした状態でお試しください。',
      };
    } finally {
      // 自動で開いたタブは閉じる
      if (autoTab) chrome.tabs.remove(autoTab.id).catch(() => {});
    }
  } catch (err) {
    console.error('syncFollowedChannels error:', err);
    return { error: `エラー: ${err.message}` };
  }
}

// タブのページ読み込み完了を待機（最大 15 秒）
function waitForTabLoad(tabId) {
  return new Promise((resolve) => {
    const listener = (id, changeInfo) => {
      if (id === tabId && changeInfo.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 15000);
  });
}

// content.js へメッセージを送りフォロー中チャンネルを取得
function askContentScript(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: 'GET_FOLLOWED' }, (response) => {
      if (chrome.runtime.lastError) {
        // content.js 未注入は正常なフォールバック（executeScript で再試行）
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

        // /following ページ専用の取得（常にこのページを使用するため）
        // 戦略0: section[data-showingmore] a[data-focus-target="true"]
        const followSection = document.querySelector('section[data-showingmore]');
        if (followSection) {
          followSection.querySelectorAll('a[data-focus-target="true"][href]').forEach((a) => {
            const href = a.getAttribute('href') || '';
            const m = href.match(/^\/([a-zA-Z0-9_]{2,50})$/);
            if (m && !EXCLUDED.has(m[1].toLowerCase())) channels.add(m[1].toLowerCase());
          });
          if (channels.size > 0) return [...channels];
        }

        // 戦略0.5: class="relative flex h-full flex-col gap-4"（/following ページのフォロー中グリッド）
        document.querySelectorAll('.relative.flex.h-full.flex-col.gap-4 a[href]').forEach((a) => {
          const href = a.getAttribute('href') || '';
          const m = href.match(/^\/([a-zA-Z0-9_]{2,50})$/);
          if (m && !EXCLUDED.has(m[1].toLowerCase())) channels.add(m[1].toLowerCase());
        });
        // /following ページのみ使用するため、結果を返す（空でもリトライに任せる）
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
