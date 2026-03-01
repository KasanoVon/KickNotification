// Kick Stream Notifier - Popup Script

const usernameInput = document.getElementById('usernameInput');
const addBtn = document.getElementById('addBtn');
const syncFollowsBtn = document.getElementById('syncFollowsBtn');
const checkNowBtn = document.getElementById('checkNowBtn');
const streamerList = document.getElementById('streamerList');
const emptyState = document.getElementById('emptyState');
const errorMsg = document.getElementById('errorMsg');

// 初期化
document.addEventListener('DOMContentLoaded', loadStreamers);

// ストリーマー追加
addBtn.addEventListener('click', addStreamer);
usernameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addStreamer();
});

// フォロー中を同期ボタン
syncFollowsBtn.addEventListener('click', syncFollowedChannels);

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
    const li = createStreamerItem(username, status);
    streamerList.appendChild(li);
  }
}

function createStreamerItem(username, status) {
  const isLive = status?.isLive || false;
  const li = document.createElement('li');
  li.className = `streamer-item${isLive ? ' is-live' : ''}`;

  const avatarSrc = status?.thumbnail || 'icons/icon48.png';
  const metaText = buildMetaText(status);

  li.innerHTML = `
    <img class="streamer-avatar" src="${avatarSrc}" alt="${username}"
         onerror="this.src='icons/icon48.png'" />
    <div class="streamer-info">
      <div class="streamer-name">
        <a href="https://kick.com/${username}" target="_blank">${username}</a>
        ${isLive ? '<span class="live-badge">LIVE</span>' : ''}
      </div>
      ${metaText ? `<div class="streamer-meta">${metaText}</div>` : ''}
    </div>
    <button class="btn btn-danger remove-btn" title="削除">×</button>
  `;

  li.querySelector('.remove-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    removeStreamer(username);
  });

  return li;
}

function buildMetaText(status) {
  if (!status?.isLive) return 'オフライン';

  const parts = [];
  if (status.viewers > 0) {
    parts.push(`<span class="viewers">${status.viewers.toLocaleString()} 人視聴中</span>`);
  }
  if (status.category) {
    parts.push(status.category);
  }
  if (status.title) {
    parts.push(status.title);
  }
  return parts.join(' · ');
}

function showError(msg) {
  errorMsg.textContent = msg;
  errorMsg.classList.remove('hidden');
}

function hideError() {
  errorMsg.classList.add('hidden');
}
