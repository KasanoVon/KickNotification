// Kick Stream Notifier - Popup Script

const syncFollowsBtn = document.getElementById('syncFollowsBtn');
const checkNowBtn = document.getElementById('checkNowBtn');
const settingsBtn = document.getElementById('settingsBtn');
const settingsPanel = document.getElementById('settingsPanel');
const streamerList = document.getElementById('streamerList');
const emptyState = document.getElementById('emptyState');
const errorMsg = document.getElementById('errorMsg');
const liveCount = document.getElementById('liveCount');
const FALLBACK_ICON = 'icons/icon48.png';

// OAuth UI
const loginForm = document.getElementById('loginForm');
const loginStatus = document.getElementById('loginStatus');
const clientIdInput = document.getElementById('clientIdInput');
const clientSecretInput = document.getElementById('clientSecretInput');
const loginBtn = document.getElementById('loginBtn');
const logoutBtn = document.getElementById('logoutBtn');
const authAvatar = document.getElementById('authAvatar');
const authUsername = document.getElementById('authUsername');
const loginError = document.getElementById('loginError');

// 初期化
document.addEventListener('DOMContentLoaded', async () => {
  await Promise.all([loadStreamers(), loadAuthStatus()]);
});

// 設定パネルの開閉
settingsBtn.addEventListener('click', () => {
  settingsPanel.classList.toggle('hidden');
  settingsBtn.classList.toggle('active', !settingsPanel.classList.contains('hidden'));
});

// フォロー中を同期ボタン
syncFollowsBtn.addEventListener('click', syncFollowedChannels);

// 今すぐ更新ボタン
checkNowBtn.addEventListener('click', () => {
  checkNowBtn.disabled = true;
  chrome.runtime.sendMessage({ type: 'CHECK_NOW' }, () => {
    setTimeout(async () => {
      await loadStreamers();
      checkNowBtn.disabled = false;
    }, 1500);
  });
});

// Kick ログイン
loginBtn.addEventListener('click', async () => {
  const clientId = clientIdInput.value.trim();
  const clientSecret = clientSecretInput.value.trim();
  if (!clientId) {
    showLoginError('Client ID を入力してください');
    return;
  }

  loginBtn.disabled = true;
  loginBtn.textContent = '認証中...';
  hideLoginError();

  chrome.runtime.sendMessage(
    { type: 'KICK_LOGIN', clientId, clientSecret: clientSecret || null },
    async (result) => {
      loginBtn.disabled = false;
      loginBtn.textContent = 'Kick にログイン';
      if (result?.error) {
        showLoginError(result.error);
      } else {
        clientIdInput.value = '';
        clientSecretInput.value = '';
        await loadAuthStatus();
      }
    }
  );
});

// ログアウト
logoutBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'KICK_LOGOUT' }, async () => {
    await loadAuthStatus();
  });
});

// フォロー中チャンネルを取得して一括登録
function syncFollowedChannels() {
  syncFollowsBtn.disabled = true;
  syncFollowsBtn.querySelector('span').textContent = '取得中...';
  hideError();

  chrome.runtime.sendMessage({ type: 'SYNC_FOLLOWS' }, async (result) => {
    syncFollowsBtn.disabled = false;

    if (!result || result.error) {
      showError(result?.error || '不明なエラーが発生しました');
      syncFollowsBtn.querySelector('span').textContent = '同期';
      return;
    }

    await loadStreamers();
    syncFollowsBtn.querySelector('span').textContent =
      result.added || result.removed ? `+${result.added} / -${result.removed}` : '変更なし';
    setTimeout(() => {
      syncFollowsBtn.querySelector('span').textContent = '同期';
    }, 2500);
  });
}

// 一覧から外す。非表示リストにも入れて、次回の同期で戻ってこないようにする
async function removeStreamer(username) {
  const { streamers = [], liveStatus = {}, autoJoinStreamers = [], hiddenStreamers = [] } =
    await chrome.storage.local.get(['streamers', 'liveStatus', 'autoJoinStreamers', 'hiddenStreamers']);
  delete liveStatus[username];
  await chrome.storage.local.set({
    streamers: streamers.filter((s) => s !== username),
    liveStatus,
    autoJoinStreamers: autoJoinStreamers.filter((u) => u !== username),
    hiddenStreamers: [...new Set([...hiddenStreamers, username])],
  });
  await loadStreamers();
}

async function loadAuthStatus() {
  const { kickUser, kickAccessToken } = await chrome.storage.local.get(['kickUser', 'kickAccessToken']);

  if (kickAccessToken && kickUser) {
    loginForm.classList.add('hidden');
    loginStatus.classList.remove('hidden');
    authUsername.textContent = kickUser.username || kickUser.name || kickUser.slug || '—';
    if (kickUser.profile_pic || kickUser.avatar) {
      authAvatar.src = kickUser.profile_pic || kickUser.avatar;
    }
  } else {
    loginForm.classList.remove('hidden');
    loginStatus.classList.add('hidden');
  }
}

function showLoginError(msg) {
  loginError.textContent = msg;
  loginError.classList.remove('hidden');
}

function hideLoginError() {
  loginError.classList.add('hidden');
}

async function loadStreamers() {
  const { streamers = [], liveStatus = {} } = await chrome.storage.local.get([
    'streamers',
    'liveStatus',
  ]);

  streamerList.innerHTML = '';

  if (streamers.length === 0) {
    streamerList.appendChild(emptyState);
    emptyState.classList.remove('hidden');
    liveCount.classList.add('hidden');
    return;
  }

  // ライブ中を上位に表示
  const sorted = [...streamers].sort((a, b) => {
    const aLive = liveStatus[a]?.isLive ? 1 : 0;
    const bLive = liveStatus[b]?.isLive ? 1 : 0;
    return bLive - aLive;
  });

  // ライブ中カウント更新
  const liveNum = sorted.filter((u) => liveStatus[u]?.isLive).length;
  if (liveNum > 0) {
    liveCount.textContent = `${liveNum} LIVE`;
    liveCount.classList.remove('hidden');
  } else {
    liveCount.classList.add('hidden');
  }

  const { autoJoinStreamers = [] } = await chrome.storage.local.get('autoJoinStreamers');

  for (const username of sorted) {
    const status = liveStatus[username];
    const autoJoin = autoJoinStreamers.includes(username);
    const li = createStreamerRow(username, status, autoJoin);
    streamerList.appendChild(li);
  }
}

// 配信タイトルは配信者が自由に付けられるため、innerHTML を使わず textContent で入れる
function createStreamerRow(username, status, autoJoin) {
  const isLive = !!status?.isLive;
  const url = `https://kick.com/${username}`;
  const li = el('li', 'streamer-item');

  const avatarWrap = el('div', `avatar-wrap${isLive ? ' is-live' : ''}`);
  const img = document.createElement('img');
  img.alt = username;
  // 拡張機能のページではインラインの onerror が動かないため addEventListener で設定する
  img.addEventListener('error', () => { img.src = FALLBACK_ICON; }, { once: true });
  img.src = status?.avatar || status?.thumbnail || FALLBACK_ICON;
  avatarWrap.append(img);
  if (isLive) avatarWrap.append(el('span', 'live-dot'));

  const info = el('div', 'item-info');
  const titleText = isLive ? status.title || username : 'オフライン';
  info.append(
    link(`item-title${isLive ? '' : ' offline'}`, url, titleText),
    link('item-username', url, username)
  );
  if (isLive && status.viewers > 0) {
    info.append(el('span', 'item-viewers', `${status.viewers.toLocaleString()}人視聴中`));
  }

  const toggle = el('div', `toggle-sm${autoJoin ? ' active' : ''}`);
  toggle.title = '自動入場';
  toggle.append(el('div', 'toggle-thumb'));
  const removeBtn = el('button', 'btn-remove', '✕');
  removeBtn.title = '削除';
  const actions = el('div', 'item-actions');
  actions.append(toggle, removeBtn);

  li.append(avatarWrap, info, actions);

  removeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    removeStreamer(username);
  });

  toggle.addEventListener('click', async (e) => {
    e.stopPropagation();
    const isActive = toggle.classList.toggle('active');
    const { autoJoinStreamers: current = [] } = await chrome.storage.local.get('autoJoinStreamers');
    const updated = isActive
      ? [...new Set([...current, username])]
      : current.filter((u) => u !== username);
    await chrome.storage.local.set({ autoJoinStreamers: updated });
  });

  return li;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function link(className, href, text) {
  const a = el('a', className, text);
  a.href = href;
  a.target = '_blank';
  return a;
}

function showError(msg) {
  errorMsg.textContent = msg;
  errorMsg.classList.remove('hidden');
}

function hideError() {
  errorMsg.classList.add('hidden');
}
