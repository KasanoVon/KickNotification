// Kick Stream Notifier - Service Worker
// Kick APIを定期的にポーリングして配信開始を検知する

const CHECK_INTERVAL_MINUTES = 1;
const SYNC_INTERVAL_MINUTES = 15;
const FETCH_CONCURRENCY = 4;
const KICK_API_BASE = 'https://kick.com/api/v2/channels/';
const KICK_OAUTH_BASE = 'https://id.kick.com';
const KICK_PUBLIC_API = 'https://api.kick.com/public/v1';
const FOLLOWING_PATH = '/following/channels';
const FOLLOWING_URL = `https://kick.com${FOLLOWING_PATH}`;

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
// Bearer トークン付きで API リクエスト
async function fetchWithToken(token, url) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (!res.ok) return null;
  return res.json();
}

// ============================================================
// 定期実行
// ============================================================

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

// ============================================================
// 配信状態のチェックと通知
// ============================================================

// 登録された全ストリーマーのライブ状態をチェック
async function checkAllStreams() {
  const { streamers = [], liveStatus: previousStatus = {} } =
    await chrome.storage.local.get(['streamers', 'liveStatus']);

  if (streamers.length === 0) return;

  const newStatus = {};
  const wentLive = [];

  await forEachLimited(streamers, FETCH_CONCURRENCY, async (username) => {
    const before = previousStatus[username];
    try {
      const channelData = await fetchChannelData(username);
      if (!channelData) {
        if (before) newStatus[username] = before;
        return;
      }

      const live = channelData.livestream;
      newStatus[username] = {
        isLive: !!live,
        title: live?.session_title || '',
        category: live?.categories?.[0]?.name || '',
        viewers: live?.viewer_count || 0,
        thumbnail: live?.thumbnail?.url || channelData.user?.profile_pic || '',
        avatar: channelData.user?.profile_pic || '',
      };

      // 前回の状態がない（追加直後）ときは基準として記録するだけで通知しない
      if (before && !before.isLive && newStatus[username].isLive) {
        wentLive.push(username);
      }
    } catch (err) {
      // 通信の一時的な失敗はよくあるため警告にとどめる（前回の状態を引き継ぐ）
      console.warn(`Failed to check ${username}:`, err.message);
      // 一時的な失敗で前回の状態を失うと、復帰時に同じ配信を再通知してしまう
      if (before) newStatus[username] = before;
    }
  });

  await chrome.storage.local.set({ liveStatus: newStatus });

  for (const username of wentLive) {
    sendNotification(username, newStatus[username]);
  }
}

// items を最大 limit 件ずつ並行して処理する（一度に全件問い合わせると接続を切られるため）
async function forEachLimited(items, limit, fn) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

async function fetchChannelData(username) {
  let response;
  try {
    response = await fetchChannel(username);
  } catch {
    // 接続が切られた場合は少し待って 1 回だけやり直す
    await sleep(1000);
    response = await fetchChannel(username);
  }
  if (response.status === 429) {
    await sleep(3000);
    response = await fetchChannel(username);
  }

  if (!response.ok) {
    if (response.status === 404) {
      console.warn(`Channel not found: ${username}`);
      return null;
    }
    throw new Error(`HTTP ${response.status}`);
  }

  return response.json();
}

function fetchChannel(username) {
  return fetch(`${KICK_API_BASE}${username}`, { headers: { Accept: 'application/json' } });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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

// SPA 内の遷移で /following/channels に来たときも自動同期する
// （content.js はページとは別の環境で動くため、ページ側の pushState を検知できない）
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url) return;
  const url = new URL(changeInfo.url);
  if (url.hostname === 'kick.com' && url.pathname === FOLLOWING_PATH) {
    chrome.tabs.sendMessage(tabId, { type: 'RUN_AUTO_SYNC' }).catch(() => {});
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
    const usernames = Array.isArray(message.usernames) ? message.usernames : [];
    if (usernames.length > 0) applyFollowedList(usernames);
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

// ============================================================
// フォロー一覧の同期
// ============================================================

// 同期の取得元:
//   1. すでに開いている /following/channels タブ（何も開かない）
//   2. なければ最小化した別ウィンドウで開いて読み、すぐ閉じる
// ※ 非表示ページ（offscreen）の iframe は kick.com のログイン状態が引き継がれないため使えない
let syncInFlight = null;

function syncFollowedChannels() {
  if (!syncInFlight) {
    syncInFlight = runSync().finally(() => {
      syncInFlight = null;
    });
  }
  return syncInFlight;
}

async function runSync() {
  try {
    const usernames = await fetchFollowedList();
    if (usernames.length === 0) {
      return {
        error:
          'フォロー中チャンネルを読み取れませんでした。\nkick.com にログインした状態でお試しください。',
      };
    }
    return await applyFollowedList(usernames);
  } catch (err) {
    console.error('syncFollowedChannels error:', err);
    return { error: `エラー: ${err.message}` };
  }
}

async function fetchFollowedList() {
  const [openTab] = await chrome.tabs.query({ url: `${FOLLOWING_URL}*` });
  if (openTab) {
    const fromTab = await readFromTab(openTab.id);
    if (fromTab.length > 0) return fromTab;
  }

  return readViaMinimizedWindow();
}

// フォロー一覧をストレージに反映する（追加だけでなく、フォロー解除したチャンネルも削除する）
// 読み込み途中などで一時的に欠けた一覧を誤って反映しないよう、
// 削除は 2 回続けて一覧に無かったチャンネルだけに行う
async function applyFollowedList(followed) {
  const {
    streamers = [],
    liveStatus = {},
    hiddenStreamers = [],
    missingOnce = [],
  } = await chrome.storage.local.get([
    'streamers', 'liveStatus', 'hiddenStreamers', 'missingOnce',
  ]);

  const followedSet = new Set(followed);
  const hidden = new Set(hiddenStreamers);
  const known = [...new Set([...streamers, ...hiddenStreamers])];
  const missing = known.filter((u) => !followedSet.has(u));

  // 描画途中などで一覧が大きく欠けていた場合は削除の判定自体を見送る
  const incomplete = streamers.length >= 5 && followed.length < streamers.length / 2;
  const wasMissing = new Set(incomplete ? [] : missingOnce);
  const gone = new Set(missing.filter((u) => wasMissing.has(u)));

  const next = [
    ...streamers.filter((u) => !gone.has(u)),
    ...followed.filter((u) => !hidden.has(u) && !streamers.includes(u)),
  ];
  const keep = new Set(next);

  // 自動入場の設定はチャンネル名ごとに残しておく（一覧から一時的に消えても失われないように）
  await chrome.storage.local.set({
    streamers: next,
    liveStatus: Object.fromEntries(Object.entries(liveStatus).filter(([u]) => keep.has(u))),
    // フォロー解除が確定したチャンネルは非表示リストからも外す（再フォロー時に表示されるように）
    hiddenStreamers: hiddenStreamers.filter((u) => !gone.has(u)),
    missingOnce: incomplete ? missingOnce : missing.filter((u) => !gone.has(u)),
  });

  checkAllStreams();
  return {
    success: true,
    added: next.filter((u) => !streamers.includes(u)).length,
    removed: streamers.filter((u) => !keep.has(u)).length,
  };
}

// タブの content.js にフォロー一覧を問い合わせる。未注入なら注入してから再度問い合わせる
async function readFromTab(tabId) {
  let usernames = await askContentScript(tabId);
  if (usernames === null) {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    usernames = await askContentScript(tabId);
  }
  return usernames || [];
}

// content.js が注入されていないときは null を返す
function askContentScript(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { type: 'GET_FOLLOWED' }, (response) => {
      if (chrome.runtime.lastError) resolve(null);
      else resolve(response?.usernames || []);
    });
  });
}

// ---- 最小化ウィンドウ経由 ----

async function readViaMinimizedWindow() {
  const win = await chrome.windows.create({
    url: FOLLOWING_URL,
    state: 'minimized',
    focused: false,
  });
  const tabId = win.tabs[0].id;
  try {
    await waitForTabLoad(tabId);
    return await readFromTab(tabId);
  } finally {
    chrome.windows.remove(win.id).catch(() => {});
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
