// Kick Stream Notifier - Popup Script

const syncFollowsBtn = document.getElementById('syncFollowsBtn');
const checkNowBtn = document.getElementById('checkNowBtn');
const settingsBtn = document.getElementById('settingsBtn');
const settingsPanel = document.getElementById('settingsPanel');
const streamerList = document.getElementById('streamerList');
const emptyState = document.getElementById('emptyState');
const errorMsg = document.getElementById('errorMsg');
const liveCount = document.getElementById('liveCount');

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
  const origContent = syncFollowsBtn.innerHTML;
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
    syncFollowsBtn.querySelector('span').textContent = `${result.added}件追加`;
    setTimeout(() => {
      syncFollowsBtn.querySelector('span').textContent = '同期';
    }, 2500);
  });
}

async function removeStreamer(username) {
  const { streamers = [], liveStatus = {}, autoJoinStreamers = [] } =
    await chrome.storage.local.get(['streamers', 'liveStatus', 'autoJoinStreamers']);
  const updated = streamers.filter((s) => s !== username);
  delete liveStatus[username];
  const updatedAutoJoin = autoJoinStreamers.filter((u) => u !== username);
  await chrome.storage.local.set({
    streamers: updated,
    liveStatus,
    autoJoinStreamers: updatedAutoJoin,
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

function createStreamerRow(username, status, autoJoin) {
  const isLive = status?.isLive || false;
  const avatarSrc = status?.avatar || status?.thumbnail || 'icons/icon48.png';
  const title = status?.title || '';
  const viewers = status?.viewers || 0;

  const li = document.createElement('li');
  li.className = 'streamer-item';

  li.innerHTML = `
    <div class="avatar-wrap${isLive ? ' is-live' : ''}">
      <img src="${avatarSrc}" alt="${username}" onerror="this.src='icons/icon48.png'" />
      ${isLive ? '<span class="live-dot"></span>' : ''}
    </div>
    <div class="item-info">
      <a class="item-title${isLive ? '' : ' offline'}" href="https://kick.com/${username}" target="_blank">
        ${isLive && title ? title : isLive ? username : 'オフライン'}
      </a>
      <a class="item-username" href="https://kick.com/${username}" target="_blank">${username}</a>
      ${isLive && viewers > 0 ? `<span class="item-viewers">${viewers.toLocaleString()}人視聴中</span>` : ''}
    </div>
    <div class="item-actions">
      <div class="toggle-sm${autoJoin ? ' active' : ''}" title="自動入場">
        <div class="toggle-thumb"></div>
      </div>
      <button class="btn-remove" title="削除">✕</button>
    </div>
  `;

  li.querySelector('.btn-remove').addEventListener('click', (e) => {
    e.stopPropagation();
    removeStreamer(username);
  });

  li.querySelector('.toggle-sm').addEventListener('click', async (e) => {
    e.stopPropagation();
    const toggle = e.currentTarget;
    const isActive = toggle.classList.toggle('active');
    const { autoJoinStreamers: current = [] } = await chrome.storage.local.get('autoJoinStreamers');
    const updated = isActive
      ? [...new Set([...current, username])]
      : current.filter((u) => u !== username);
    await chrome.storage.local.set({ autoJoinStreamers: updated });
  });

  return li;
}

function showError(msg) {
  errorMsg.textContent = msg;
  errorMsg.classList.remove('hidden');
}

function hideError() {
  errorMsg.classList.add('hidden');
}
