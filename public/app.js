// ============ UMPAT Communication — Client Logic (v2: permanent accounts) ============

let socket = null;
let myUsername = ''; // display name
let myProfilePicture = '';
let currentChatUserId = null; // username (lowercase key) ng kausap
let currentChatUserName = null; // display name ng kausap
let registeredUsers = []; // lahat ng naka-register na users (maliban sa sarili)
let onlineUsernames = new Set();
let localStream = null;
let peerConnection = null;
let pendingCallFrom = null;
let pendingOffer = null;
let inCallWith = null;

const chatHistory = {}; // username -> array of {message, timestamp, mine}
const lastMessages = {}; // username -> {message, timestamp, mine}

// Dark mode agad i-apply bago mag-render ng kahit ano, para walang "flash"
if (localStorage.getItem('umpat_dark_mode') === 'true') {
  document.documentElement.classList.add('dark-mode');
}

// I-detect kung binuksan ang site sa loob ng Facebook/Messenger/Instagram
// in-app browser — hindi gagana ang camera doon kahit anong permission.
(function checkInAppBrowser() {
  const ua = navigator.userAgent || '';
  const isInApp = /FBAN|FBAV|Instagram|Line\//i.test(ua);
  if (!isInApp) return;
  const banner = document.getElementById('webview-banner');
  if (!banner) return;
  banner.classList.remove('hidden');
  const copyBtn = document.getElementById('copy-link-btn');
  const dismissBtn = document.getElementById('dismiss-banner-btn');
  copyBtn.addEventListener('click', () => {
    const url = window.location.href;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard
        .writeText(url)
        .then(() => showToast('Na-kopya ang link!'))
        .catch(() => window.prompt('Kopyahin ang link:', url));
    } else {
      window.prompt('Kopyahin ang link:', url);
    }
  });
  dismissBtn.addEventListener('click', () => banner.classList.add('hidden'));
})();

// Toggle button para itago/ipakita ang Navigation Rail (para hindi nakaka-distract)
(function setupNavRailToggle() {
  const navRail = document.getElementById('nav-rail');
  const toggleBtn = document.getElementById('nav-rail-toggle');
  if (!navRail || !toggleBtn) return;
  if (localStorage.getItem('umpat_nav_collapsed') === 'true') {
    navRail.classList.add('collapsed');
  }
  toggleBtn.addEventListener('click', () => {
    navRail.classList.toggle('collapsed');
    localStorage.setItem('umpat_nav_collapsed', navRail.classList.contains('collapsed') ? 'true' : 'false');
  });
})();

const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

// ---------- Helpers ----------

function getInitials(name) {
  return (name || '?').trim().charAt(0).toUpperCase();
}

function avatarInner(name, profilePicture, extra = '') {
  if (profilePicture) {
    return `<img src="${profilePicture}" alt="${escapeHtml(name)}">${extra}`;
  }
  return `${getInitials(name)}${extra}`;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function showToast(msg, duration = 3000) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.remove('hidden');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.add('hidden'), duration);
}

function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) {
    return d.toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' });
  }
  return d.toLocaleDateString('en-PH', { month: 'short', day: 'numeric' });
}

async function apiFetch(url, options = {}) {
  const token = localStorage.getItem('umpat_token');
  const headers = Object.assign({ 'Content-Type': 'application/json' }, options.headers || {});
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(url, Object.assign({}, options, { headers }));
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'May error na nangyari.');
  return data;
}

// ---------- Auth Screen (Login / Signup) ----------

const joinScreen = document.getElementById('join-screen');
const appEl = document.getElementById('app');
const myAvatar = document.getElementById('my-avatar');
const myNameLabel = document.getElementById('my-name-label');

const tabLogin = document.getElementById('tab-login');
const tabSignup = document.getElementById('tab-signup');
const authUsername = document.getElementById('auth-username');
const authPassword = document.getElementById('auth-password');
const authSubmitBtn = document.getElementById('auth-submit-btn');
const authError = document.getElementById('auth-error');
const authLoading = document.getElementById('auth-loading');

let authMode = 'login';

tabLogin.addEventListener('click', () => switchAuthMode('login'));
tabSignup.addEventListener('click', () => switchAuthMode('signup'));

function switchAuthMode(mode) {
  authMode = mode;
  tabLogin.classList.toggle('active', mode === 'login');
  tabSignup.classList.toggle('active', mode === 'signup');
  authSubmitBtn.textContent = mode === 'login' ? 'Mag-login' : 'Gumawa ng Account';
  authError.classList.add('hidden');
}

authSubmitBtn.addEventListener('click', submitAuth);
authPassword.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') submitAuth();
});

async function submitAuth() {
  const username = authUsername.value.trim();
  const password = authPassword.value;
  authError.classList.add('hidden');

  if (!username || !password) {
    authError.textContent = 'Punuan ang username at password.';
    authError.classList.remove('hidden');
    return;
  }

  authLoading.classList.remove('hidden');
  authSubmitBtn.disabled = true;

  try {
    const endpoint = authMode === 'login' ? '/api/login' : '/api/register';
    const data = await apiFetch(endpoint, {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
    localStorage.setItem('umpat_token', data.token);
    localStorage.setItem('umpat_username', data.username);
    enterApp(data.token, data.username);
  } catch (err) {
    authError.textContent = err.message;
    authError.classList.remove('hidden');
  } finally {
    authLoading.classList.add('hidden');
    authSubmitBtn.disabled = false;
  }
}

// ---------- Auto-login kung may naka-save nang session ----------

(function tryAutoLogin() {
  const token = localStorage.getItem('umpat_token');
  const username = localStorage.getItem('umpat_username');
  if (token && username) {
    enterApp(token, username);
  }
})();

function enterApp(token, username) {
  myUsername = username;
  joinScreen.classList.add('hidden');
  appEl.classList.remove('hidden');
  myAvatar.innerHTML = avatarInner(username, myProfilePicture);
  myNameLabel.textContent = username;

  socket = io({ auth: { token } });

  socket.on('connect_error', (err) => {
    showToast('Hindi ma-verify ang session: ' + err.message, 5000);
    if (err.message.includes('Invalid') || err.message.includes('expired')) {
      logout();
    }
  });

  socket.on('online-users', (usernames) => {
    onlineUsernames = new Set(usernames);
    renderContacts();
  });

  socket.on('chat-message', (data) => {
    const contact = data.from === getUsernameKey() ? data.to : data.from;
    addMessageToHistory(contact, {
      message: data.message,
      timestamp: data.timestamp,
      mine: data.from === getUsernameKey(),
    });
    lastMessages[contact] = {
      message: data.message,
      timestamp: data.timestamp,
      mine: data.from === getUsernameKey(),
    };
    if (contact === currentChatUserId) {
      renderMessages();
    } else if (data.from !== getUsernameKey()) {
      showToast(`Bagong mensahe mula kay ${nameForUsername(data.from)}`);
    }
    renderContacts();
  });

  socket.on('chat-history', ({ withUser, messages }) => {
    chatHistory[withUser] = messages.map((m) => ({
      message: m.message,
      timestamp: m.timestamp,
      mine: m.from === getUsernameKey(),
    }));
    if (withUser === currentChatUserId) renderMessages();
  });

  registerSocketCallHandlers();

  loadContactsAndHistory();
}

function getUsernameKey() {
  // Ang server ang may hawak ng totoong lowercase key; kaya lang, para sa client
  // logic dito, kino-compare lang natin ang "from" laban sa aking sariling
  // socket username na ibinalik ng bawat event papasok. Gamit natin ang helper
  // socket.username mula sa auth response (naka-store bilang myUsernameKey).
  return myUsernameKey;
}

let myUsernameKey = '';

async function loadContactsAndHistory() {
  try {
    const [users, last, me] = await Promise.all([
      apiFetch('/api/users'),
      apiFetch('/api/last-messages'),
      apiFetch('/api/me'),
    ]);
    registeredUsers = users; // [{username, displayName, profilePicture}]
    Object.assign(lastMessages, last);
    // hanapin ang sariling lowercase key sa pamamagitan ng token payload —
    // pinaka-simple: hilingin natin sa /api/users list, pero mas madali:
    // i-decode ang JWT client-side lang para makuha ang username key.
    myUsernameKey = decodeJwtUsername(localStorage.getItem('umpat_token'));
    myProfilePicture = me.profilePicture || '';
    myAvatar.innerHTML = avatarInner(myUsername, myProfilePicture);
    renderContacts();
  } catch (err) {
    showToast('Hindi makuha ang listahan ng contacts: ' + err.message, 5000);
  }
}

function decodeJwtUsername(token) {
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    return payload.username;
  } catch (err) {
    return '';
  }
}

function nameForUsername(usernameKey) {
  const u = registeredUsers.find((r) => r.username === usernameKey);
  return u ? u.displayName : usernameKey;
}

function pictureForUsername(usernameKey) {
  const u = registeredUsers.find((r) => r.username === usernameKey);
  return u ? u.profilePicture || '' : '';
}

function logout() {
  localStorage.removeItem('umpat_token');
  localStorage.removeItem('umpat_username');
  if (socket) socket.disconnect();
  window.location.reload();
}

document.getElementById('logout-btn').addEventListener('click', () => {
  if (confirm('Sigurado ka bang gusto mong mag-logout?')) logout();
});

// ---------- Contacts List ----------

const contactsList = document.getElementById('contacts-list');

function renderContacts() {
  if (registeredUsers.length === 0) {
    contactsList.innerHTML = '<div class="no-contacts">Wala pang ibang naka-register na user. Ipaalam sa kausap mo na gumawa rin ng account.</div>';
    return;
  }
  const sorted = [...registeredUsers].sort((a, b) => {
    const ta = lastMessages[a.username] ? lastMessages[a.username].timestamp : 0;
    const tb = lastMessages[b.username] ? lastMessages[b.username].timestamp : 0;
    return tb - ta;
  });
  contactsList.innerHTML = '';
  sorted.forEach((user) => {
    const isOnline = onlineUsernames.has(user.username);
    const last = lastMessages[user.username];
    const previewText = last
      ? (last.mine ? 'Ikaw: ' : '') + last.message
      : isOnline
      ? 'Online'
      : 'Offline';
    const previewTime = last ? formatTime(last.timestamp) : '';

    const div = document.createElement('div');
    div.className = 'contact-item' + (user.username === currentChatUserId ? ' active' : '');
    div.innerHTML = `
      <div class="avatar">${avatarInner(user.displayName, user.profilePicture, isOnline ? '<span class="online-dot"></span>' : '')}</div>
      <div class="contact-info">
        <div class="contact-name">${escapeHtml(user.displayName)}</div>
        <div class="contact-preview">
          <span>${escapeHtml(previewText)}</span>
          ${previewTime ? `<span class="preview-time">${previewTime}</span>` : ''}
        </div>
      </div>
    `;
    div.addEventListener('click', () => openChat(user.username, user.displayName));
    contactsList.appendChild(div);
  });
}

// ---------- Chat Window ----------

const noChatSelected = document.getElementById('no-chat-selected');
const chatWindow = document.getElementById('chat-window');
const chatContactName = document.getElementById('chat-contact-name');
const chatContactStatus = document.getElementById('chat-contact-status');
const chatAvatar = document.getElementById('chat-avatar');
const messagesContainer = document.getElementById('messages-container');
const messageInput = document.getElementById('message-input');
const sendBtn = document.getElementById('send-btn');
const backBtn = document.getElementById('back-btn');

function openChat(usernameKey, displayName) {
  currentChatUserId = usernameKey;
  currentChatUserName = displayName;
  noChatSelected.classList.add('hidden');
  chatWindow.classList.remove('hidden');
  chatContactName.textContent = displayName;
  chatAvatar.innerHTML = avatarInner(displayName, pictureForUsername(usernameKey));
  chatContactStatus.textContent = onlineUsernames.has(usernameKey) ? 'Online' : 'Offline';
  appEl.classList.add('chat-open');
  renderContacts();

  if (!chatHistory[usernameKey]) {
    messagesContainer.innerHTML = '<div class="no-contacts">Kinukuha ang mga lumang mensahe...</div>';
    socket.emit('get-history', { withUser: usernameKey });
  } else {
    renderMessages();
  }
}

backBtn.addEventListener('click', () => {
  appEl.classList.remove('chat-open');
});

sendBtn.addEventListener('click', sendMessage);
messageInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') sendMessage();
});

function sendMessage() {
  const text = messageInput.value.trim();
  if (!text || !currentChatUserId) return;
  socket.emit('chat-message', { to: currentChatUserId, message: text });
  messageInput.value = '';
}

function addMessageToHistory(usernameKey, msg) {
  if (!chatHistory[usernameKey]) chatHistory[usernameKey] = [];
  chatHistory[usernameKey].push(msg);
}

function renderMessages() {
  const msgs = chatHistory[currentChatUserId] || [];
  if (msgs.length === 0) {
    messagesContainer.innerHTML = '<div class="no-contacts">Wala pang mensahe. Magsimula ng usapan!</div>';
    return;
  }
  messagesContainer.innerHTML = msgs
    .map(
      (m) => `
    <div class="message-row ${m.mine ? 'mine' : 'theirs'}">
      <div class="message-bubble">${escapeHtml(m.message)}</div>
    </div>
  `
    )
    .join('');
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

// ---------- Video Call (WebRTC) — by username na ngayon, hindi socket id ----------

const videoCallBtn = document.getElementById('video-call-btn');
const voiceCallBtn = document.getElementById('voice-call-btn');
const videoCallOverlay = document.getElementById('video-call-overlay');
const localVideo = document.getElementById('local-video');
const remoteVideo = document.getElementById('remote-video');
const callStatus = document.getElementById('call-status');
const endCallBtn = document.getElementById('end-call-btn');
const toggleMicBtn = document.getElementById('toggle-mic-btn');
const toggleCamBtn = document.getElementById('toggle-cam-btn');

const incomingCallModal = document.getElementById('incoming-call-modal');
const callerName = document.getElementById('caller-name');
const callerAvatar = document.getElementById('caller-avatar');
const incomingCallLabel = document.getElementById('incoming-call-label');
const acceptCallBtn = document.getElementById('accept-call-btn');
const declineCallBtn = document.getElementById('decline-call-btn');

function registerSocketCallHandlers() {
  socket.on('incoming-call', async ({ from, offer }) => {
    if (peerConnection) {
      socket.emit('end-call', { to: from });
      return;
    }
    pendingCallFrom = from;
    pendingOffer = offer;
    const displayName = nameForUsername(from);
    callerName.textContent = displayName;
    callerAvatar.innerHTML = avatarInner(displayName, pictureForUsername(from));
    incomingCallLabel.textContent = 'Video calling...';
    incomingCallModal.classList.remove('hidden');
  });

  socket.on('call-answered', async ({ answer }) => {
    if (!peerConnection) return;
    await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
    callStatus.textContent = 'Nakakonekta';
  });

  socket.on('ice-candidate', async ({ candidate }) => {
    if (peerConnection && candidate) {
      try {
        await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (err) {
        console.error('Error sa pag-add ng ICE candidate:', err);
      }
    }
  });

  socket.on('call-ended', () => {
    showToast('Natapos ang tawag.');
    endCall(false);
  });
}

videoCallBtn.addEventListener('click', () => startCall(true));
voiceCallBtn.addEventListener('click', () => startCall(false));

async function startCall(withVideo) {
  if (!currentChatUserId) return;
  if (!window.isSecureContext) {
    showToast('Kailangan ng HTTPS para gumana ang camera/mic.', 5000);
    return;
  }
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: withVideo, audio: true });
  } catch (err) {
    showToast('Hindi ma-access ang camera/mic: ' + err.message, 5000);
    return;
  }
  localVideo.srcObject = localStream;
  localVideo.classList.toggle('hidden', !withVideo);
  inCallWith = currentChatUserId;
  showCallOverlay('Tumatawag...');

  peerConnection = createPeerConnection(currentChatUserId);
  localStream.getTracks().forEach((track) => peerConnection.addTrack(track, localStream));

  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);

  socket.emit('call-user', { to: currentChatUserId, offer });
}

function createPeerConnection(targetUsername) {
  const pc = new RTCPeerConnection(ICE_SERVERS);

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('ice-candidate', { to: targetUsername, candidate: event.candidate });
    }
  };

  pc.ontrack = (event) => {
    remoteVideo.srcObject = event.streams[0];
    callStatus.textContent = 'Nakakonekta';
  };

  pc.onconnectionstatechange = () => {
    if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) {
      endCall(false);
    }
  };

  return pc;
}

acceptCallBtn.addEventListener('click', async () => {
  incomingCallModal.classList.add('hidden');
  if (!window.isSecureContext) {
    showToast('Kailangan ng HTTPS para gumana ang camera/mic.', 5000);
    socket.emit('end-call', { to: pendingCallFrom });
    pendingCallFrom = null;
    pendingOffer = null;
    return;
  }
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  } catch (err) {
    showToast('Hindi ma-access ang camera/mic: ' + err.message, 5000);
    socket.emit('end-call', { to: pendingCallFrom });
    pendingCallFrom = null;
    pendingOffer = null;
    return;
  }
  localVideo.srcObject = localStream;
  localVideo.classList.remove('hidden');
  inCallWith = pendingCallFrom;
  showCallOverlay('Kumokonekta...');

  peerConnection = createPeerConnection(pendingCallFrom);
  localStream.getTracks().forEach((track) => peerConnection.addTrack(track, localStream));

  await peerConnection.setRemoteDescription(new RTCSessionDescription(pendingOffer));
  const answer = await peerConnection.createAnswer();
  await peerConnection.setLocalDescription(answer);

  socket.emit('answer-call', { to: pendingCallFrom, answer });

  if (!currentChatUserId) {
    openChat(pendingCallFrom, nameForUsername(pendingCallFrom));
  }

  pendingCallFrom = null;
  pendingOffer = null;
});

declineCallBtn.addEventListener('click', () => {
  incomingCallModal.classList.add('hidden');
  if (pendingCallFrom) socket.emit('end-call', { to: pendingCallFrom });
  pendingCallFrom = null;
  pendingOffer = null;
});

function showCallOverlay(status) {
  videoCallOverlay.classList.remove('hidden');
  callStatus.textContent = status;
}

endCallBtn.addEventListener('click', () => endCall(true));

function endCall(notifyPeer) {
  if (notifyPeer && inCallWith) {
    socket.emit('end-call', { to: inCallWith });
  }
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }
  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop());
    localStream = null;
  }
  remoteVideo.srcObject = null;
  localVideo.srcObject = null;
  videoCallOverlay.classList.add('hidden');
  pendingCallFrom = null;
  pendingOffer = null;
  inCallWith = null;
}

toggleMicBtn.addEventListener('click', () => {
  if (!localStream) return;
  const audioTrack = localStream.getAudioTracks()[0];
  if (!audioTrack) return;
  audioTrack.enabled = !audioTrack.enabled;
  toggleMicBtn.classList.toggle('off', !audioTrack.enabled);
});

toggleCamBtn.addEventListener('click', () => {
  if (!localStream) return;
  const videoTrack = localStream.getVideoTracks()[0];
  if (!videoTrack) return;
  videoTrack.enabled = !videoTrack.enabled;
  toggleCamBtn.classList.toggle('off', !videoTrack.enabled);
});

// ---------- Search filter ----------

const searchInput = document.getElementById('search-input');
searchInput.addEventListener('input', () => {
  const q = searchInput.value.trim().toLowerCase();
  const items = contactsList.querySelectorAll('.contact-item');
  items.forEach((item) => {
    const name = item.querySelector('.contact-name').textContent.toLowerCase();
    item.style.display = name.includes(q) ? 'flex' : 'none';
  });
});

// ---------- Settings (Dark Mode + Profile Picture) ----------

const settingsBtn = document.getElementById('settings-btn');
const settingsModal = document.getElementById('settings-modal');
const closeSettingsBtn = document.getElementById('close-settings-btn');
const settingsAvatar = document.getElementById('settings-avatar');
const profilePhotoInput = document.getElementById('profile-photo-input');
const choosePhotoBtn = document.getElementById('choose-photo-btn');
const removePhotoBtn = document.getElementById('remove-photo-btn');
const settingsDisplayName = document.getElementById('settings-displayname');
const saveNameBtn = document.getElementById('save-name-btn');
const darkModeToggle = document.getElementById('dark-mode-toggle');
const settingsStatus = document.getElementById('settings-status');

darkModeToggle.checked = document.documentElement.classList.contains('dark-mode');

function openSettings() {
  settingsDisplayName.value = myUsername;
  settingsAvatar.innerHTML = avatarInner(myUsername, myProfilePicture);
  settingsStatus.classList.add('hidden');
  settingsModal.classList.remove('hidden');
}

settingsBtn.addEventListener('click', openSettings);
myAvatar.addEventListener('click', openSettings);

closeSettingsBtn.addEventListener('click', () => settingsModal.classList.add('hidden'));

darkModeToggle.addEventListener('change', () => {
  document.documentElement.classList.toggle('dark-mode', darkModeToggle.checked);
  localStorage.setItem('umpat_dark_mode', darkModeToggle.checked ? 'true' : 'false');
});

function showSettingsStatus(msg, isError = true) {
  settingsStatus.textContent = msg;
  settingsStatus.style.color = isError ? 'var(--danger-red)' : 'var(--online-green)';
  settingsStatus.classList.remove('hidden');
}

choosePhotoBtn.addEventListener('click', () => profilePhotoInput.click());

profilePhotoInput.addEventListener('change', async () => {
  const file = profilePhotoInput.files && profilePhotoInput.files[0];
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    showSettingsStatus('Larawan lang ang puwede.');
    return;
  }
  try {
    const resized = await resizeImageToDataUrl(file, 320, 0.75);
    settingsAvatar.innerHTML = avatarInner(myUsername, resized);
    const data = await apiFetch('/api/profile', {
      method: 'POST',
      body: JSON.stringify({ profilePicture: resized }),
    });
    myProfilePicture = data.profilePicture || '';
    myAvatar.innerHTML = avatarInner(myUsername, myProfilePicture);
    showSettingsStatus('Na-update ang larawan!', false);
  } catch (err) {
    showSettingsStatus(err.message);
  }
  profilePhotoInput.value = '';
});

removePhotoBtn.addEventListener('click', async () => {
  try {
    const data = await apiFetch('/api/profile', {
      method: 'POST',
      body: JSON.stringify({ profilePicture: '' }),
    });
    myProfilePicture = '';
    settingsAvatar.innerHTML = avatarInner(myUsername, '');
    myAvatar.innerHTML = avatarInner(myUsername, '');
    showSettingsStatus('Naalis ang larawan.', false);
  } catch (err) {
    showSettingsStatus(err.message);
  }
});

saveNameBtn.addEventListener('click', async () => {
  const newName = settingsDisplayName.value.trim();
  if (newName.length < 2) {
    showSettingsStatus('Kailangan ng hindi bababa sa 2 letra.');
    return;
  }
  try {
    const data = await apiFetch('/api/profile', {
      method: 'POST',
      body: JSON.stringify({ displayName: newName }),
    });
    myUsername = data.displayName;
    localStorage.setItem('umpat_username', myUsername);
    myNameLabel.textContent = myUsername;
    myAvatar.innerHTML = avatarInner(myUsername, myProfilePicture);
    showSettingsStatus('Na-save ang pangalan!', false);
  } catch (err) {
    showSettingsStatus(err.message);
  }
});

// Ina-resize/kino-compress ang larawan gamit ang canvas bago i-upload,
// para maliit lang ang file size (mas mabilis mag-load sa mobile data).
function resizeImageToDataUrl(file, maxSize, quality) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Hindi mabasa ang file.'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Hindi mabasa ang larawan.'));
      img.onload = () => {
        let { width, height } = img;
        if (width > height && width > maxSize) {
          height = Math.round((height * maxSize) / width);
          width = maxSize;
        } else if (height > maxSize) {
          width = Math.round((width * maxSize) / height);
          height = maxSize;
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}
