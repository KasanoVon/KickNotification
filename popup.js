// Kick Stream Notifier - Popup Script

const usernameInput = document.getElementById('usernameInput');
const addBtn = document.getElementById('addBtn');
const syncFollowsBtn = document.getElementById('syncFollowsBtn');
const checkNowBtn = document.getElementById('checkNowBtn');
const streamerList = document.getElementById('streamerList');
const emptyState = document.getElementById('emptyState');
const errorMsg = document.getElementById('errorMsg');

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

// ストリーマー追加
addBtn.addEventListener('click', addStreamer);
usernameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addStreamer();
});

// フォロー中を同期ボタン
syncFollowsBtn.addEventListener('click', syncFollowedChannels);

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
      loginBtn.textContent = 'Kickにログイン';
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

// 今すぐ確認ボタン
checkNowBtn.addEventListener('click', () => {
  checkNowBtn.disabled = true;
  checkNowBtn.textContent = '確認中...';
  chrome.runtime.sendMessage({ type: 'CHECK_NOW' }, () => {
    setTimeout(() => {
      loadStreamers();
      checkNowBtn.disabled = false;
      checkNowBtn.textContent = '今すぐ確認';
    }, 1500);
  });
});

// フォロー中チャンネルを取得して一括登録
// fetch は CORS バイパスのため background.js (Service Worker) に委譲する
function syncFollowedChannels() {
  syncFollowsBtn.disabled = true;
  syncFollowsBtn.textContent = '取得中...';
  hideError();

  chrome.runtime.sendMessage({ type: 'SYNC_FOLLOWS' }, async (result) => {
    syncFollowsBtn.disabled = false;

    if (!result || result.error) {
      showError(result?.error || '不明なエラーが発生しました');
      syncFollowsBtn.textContent = 'フォロー中を同期';
      return;
    }

    await loadStreamers();
    syncFollowsBtn.textContent = `${result.added}件追加しました`;
    setTimeout(() => {
      syncFollowsBtn.textContent = 'フォロー中を同期';
    }, 2500);
  });
}

async function addStreamer() {
  const username = usernameInput.value.trim().toLowerCase();
  if (!username) return;

  if (!/^[a-z0-9_]{1,50}$/.test(username)) {
    showError('ユーザー名は英数字とアンダースコアのみ使用できます');
    return;
  }

  const { streamers = [] } = await chrome.storage.local.get('streamers');
  if (streamers.includes(username)) {
    showError('このストリーマーはすでに登録されています');
    return;
  }

  addBtn.disabled = true;
  addBtn.textContent = '確認中...';
  hideError();

  try {
    // チャンネルの存在確認
    const res = await fetch(`https://kick.com/api/v2/channels/${username}`, {
      headers: { Accept: 'application/json' },
    });

    if (!res.ok) {
      showError(res.status === 404 ? 'ユーザーが見つかりません' : 'APIエラーが発生しました');
      return;
    }

    streamers.push(username);
    await chrome.storage.local.set({ streamers });
    usernameInput.value = '';
    await loadStreamers();
    // 追加直後にライブ状態を取得
    chrome.runtime.sendMessage({ type: 'CHECK_NOW' });
  } catch {
    showError('ネットワークエラーが発生しました');
  } finally {
    addBtn.disabled = false;
    addBtn.textContent = '追加';
  }
}

async function removeStreamer(username) {
  const { streamers = [], liveStatus = {} } = await chrome.storage.local.get([
    'streamers',
    'liveStatus',
  ]);
  const updated = streamers.filter((s) => s !== username);
  delete liveStatus[username];
  await chrome.storage.local.set({ streamers: updated, liveStatus });
  await loadStreamers();
}

async function loadAuthStatus() {
  const { kickUser, kickAccessToken } = await chrome.storage.local.get(['kickUser', 'kickAccessToken']);

  if (kickAccessToken && kickUser) {
    // ログイン済み表示
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
    return;
  }

  // ライブ中を上位に表示
  const sorted = [...streamers].sort((a, b) => {
    const aLive = liveStatus[a]?.isLive ? 1 : 0;
    const bLive = liveStatus[b]?.isLive ? 1 : 0;
    return bLive - aLive;
  });

  for (const username of sorted) {
    const status = liveStatus[username];
    const li = await createStreamerTile(username, status);
    streamerList.appendChild(li);
  }
}

async function createStreamerTile(username, status) {
  const isLive = status?.isLive || false;
  const { autoJoinStreamers = [] } = await chrome.storage.local.get('autoJoinStreamers');
  const autoJoin = autoJoinStreamers.includes(username);

  const li = document.createElement('li');
  li.className = `tile-item${isLive ? ' is-live' : ''}`;

  const thumbSrc = status?.thumbnail || '';
  const avatarSrc = status?.avatar || status?.thumbnail || 'icons/icon48.png';

  // サムネイル部分
  const thumbHtml = isLive && thumbSrc
    ? `<a class="tile-thumb" href="https://kick.com/${username}" target="_blank">
        <img src="${thumbSrc}" alt="${username}" onerror="this.src='icons/icon48.png'" />
        <span class="tile-badge-live">LIVE</span>
        ${status.viewers > 0 ? `<span class="tile-badge-viewers">${status.viewers.toLocaleString()}人視聴中</span>` : ''}
       </a>`
    : `<a class="tile-thumb" href="https://kick.com/${username}" target="_blank">
        <div class="tile-thumb-offline">
          <img src="${avatarSrc}" alt="${username}" onerror="this.src='icons/icon48.png'" />
        </div>
        ${isLive ? '<span class="tile-badge-live">LIVE</span>' : ''}
       </a>`;

  // タイトル or オフライン表示
  const subHtml = isLive && status?.title
    ? `<div class="tile-title">${status.title}</div>`
    : (!isLive ? `<div class="tile-offline">オフライン</div>` : '');

  li.innerHTML = `
    ${thumbHtml}
    <div class="tile-info">
      <div class="tile-top">
        <img class="tile-avatar" src="${avatarSrc}" alt="${username}" onerror="this.src='icons/icon48.png'" />
        <a class="tile-username" href="https://kick.com/${username}" target="_blank">${username}</a>
        <div class="tile-actions">
          <div class="toggle-sm${autoJoin ? ' active' : ''}" data-user="${username}" title="自動入場">
            <div class="toggle-thumb"></div>
          </div>
          <button class="btn-danger-sm remove-btn" title="削除">×</button>
        </div>
      </div>
      ${subHtml}
    </div>
  `;

  li.querySelector('.remove-btn').addEventListener('click', (e) => {
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
