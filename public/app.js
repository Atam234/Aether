// ============ UMPAT Communication — Client Logic (v2: permanent accounts) ============

let socket = null;
let appMode = 'online'; // 'online' (may database) o 'guest' (LAN mode, walang database)
let myUsername = ''; // display name
let myProfilePicture = '';
let currentChatUserId = null; // username (lowercase key) ng kausap
let currentChatUserName = null; // display name ng kausap
let registeredUsers = []; // lahat ng naka-register (online mode) o kasalukuyang online (guest mode)
let onlineUsernames = new Set();
let localStream = null;
let peerConnection = null;
let pendingCallFrom = null;
let pendingOffer = null;
let inCallWith = null;

const chatHistory = {}; // username -> array of {message, timestamp, mine}
const lastMessages = {}; // username -> {message, timestamp, mine}

// Dark mode agad i-apply bago mag-render ng kahit ano, para walang "flash"
// Default: dark navy (LAN-NET style) maliban kung pinatay sa Settings
if (localStorage.getItem('umpat_dark_mode') !== 'false') {
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

// STUN muna bilang default/fallback — ia-upgrade ito ng TURN server (kung
// naka-configure sa Render) pagkatapos mag-login, para reliable pa rin sa
// mobile data at ibang mahigpit na network.
let ICE_SERVERS = {
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
  if (appMode === 'guest') {
    submitGuestJoin();
    return;
  }

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

function submitGuestJoin() {
  const name = authUsername.value.trim();
  authError.classList.add('hidden');
  if (!name) {
    authError.textContent = 'Maglagay ng pangalan.';
    authError.classList.remove('hidden');
    return;
  }
  localStorage.setItem('umpat_guest_name', name);
  enterApp(null, name);
}

// ---------- Auto-login kung may naka-save nang session (online mode lang) ----------

function setupJoinScreenForMode() {
  if (appMode !== 'guest') return;
  document.getElementById('guest-mode-notice').classList.remove('hidden');
  document.getElementById('auth-tabs').classList.add('hidden');
  authPassword.classList.add('hidden');
  authSubmitBtn.textContent = 'Sumali';
  authUsername.placeholder = 'Pangalan mo...';
  const savedGuestName = localStorage.getItem('umpat_guest_name');
  if (savedGuestName) authUsername.value = savedGuestName;
}

(async function detectModeThenInit() {
  try {
    const res = await fetch('/api/mode');
    const data = await res.json();
    appMode = data.hasDatabase ? 'online' : 'guest';
  } catch (err) {
    appMode = 'online'; // default kung hindi ma-check, i-assume online
  }
  setupJoinScreenForMode();

  if (appMode === 'online') {
    const token = localStorage.getItem('umpat_token');
    const username = localStorage.getItem('umpat_username');
    if (token && username) enterApp(token, username);
  }
})();

function enterApp(token, username) {
  myUsername = username;
  joinScreen.classList.add('hidden');
  appEl.classList.remove('hidden');
  myAvatar.innerHTML = avatarInner(username, myProfilePicture);
  myNameLabel.textContent = username;

  if (appMode === 'guest') {
    myUsernameKey = username.toLowerCase().slice(0, 24);
    socket = io({ auth: { guestName: username } });
    document.getElementById('settings-profile-section').classList.add('hidden');
    document.getElementById('settings-displayname-section').classList.add('hidden');
  } else {
    socket = io({ auth: { token } });
  }

  socket.on('connect_error', (err) => {
    showToast('Hindi ma-verify ang session: ' + err.message, 5000);
    if (err.message.includes('Invalid') || err.message.includes('expired')) {
      logout();
    }
  });

  socket.on('online-users', (list) => {
    onlineUsernames = new Set(list.map((u) => u.username));
    if (appMode === 'guest') {
      registeredUsers = list.filter((u) => u.username !== myUsernameKey);
    }
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
  if (appMode === 'guest') {
    // Sa Guest/LAN mode, ang 'online-users' socket broadcast na mismo ang
    // nagpo-populate ng contacts list — walang database na kukunan pa ng
    // listahan, huling mensahe, o TURN credentials.
    renderContacts();
    return;
  }
  try {
    const [users, last, me, iceData] = await Promise.all([
      apiFetch('/api/users'),
      apiFetch('/api/last-messages'),
      apiFetch('/api/me'),
      apiFetch('/api/ice-servers').catch(() => null),
    ]);
    registeredUsers = users; // [{username, displayName, profilePicture}]
    Object.assign(lastMessages, last);
    // hanapin ang sariling lowercase key sa pamamagitan ng token payload —
    // pinaka-simple: hilingin natin sa /api/users list, pero mas madali:
    // i-decode ang JWT client-side lang para makuha ang username key.
    myUsernameKey = decodeJwtUsername(localStorage.getItem('umpat_token'));
    myProfilePicture = me.profilePicture || '';
    myAvatar.innerHTML = avatarInner(myUsername, myProfilePicture);
    if (iceData && Array.isArray(iceData.iceServers) && iceData.iceServers.length > 0) {
      ICE_SERVERS = { iceServers: iceData.iceServers };
    }
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
    if (appMode === 'guest') {
      chatHistory[usernameKey] = [];
      renderMessages();
    } else {
      messagesContainer.innerHTML = '<div class="no-contacts">Kinukuha ang mga lumang mensahe...</div>';
      socket.emit('get-history', { withUser: usernameKey });
    }
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

const RING_TIMEOUT_MS = 45000; // gaano katagal mag-ring bago ituring na "walang sumagot"
const DISCONNECT_GRACE_MS = 10000; // palugit kapag pansamantalang nawala ang koneksyon

let pendingCallVideo = true; // video call ba o voice call ang papasok na tawag
let currentCallVideo = true;
// ICE candidates na dumating BAGO pa na-set ang remote description (o bago pa
// nagawa ang peerConnection sa side ng tinatawagan). Dati, itinatapon lang ang
// mga ito — kaya hindi makabuo ng koneksyon at itim lang ang screen.
let queuedCandidates = [];
let ringTimer = null;
let disconnectTimer = null;

function clearCallTimers() {
  clearTimeout(ringTimer);
  clearTimeout(disconnectTimer);
  ringTimer = null;
  disconnectTimer = null;
}

async function flushQueuedCandidates() {
  if (!peerConnection || !peerConnection.remoteDescription) return;
  const list = queuedCandidates;
  queuedCandidates = [];
  for (const c of list) {
    try {
      await peerConnection.addIceCandidate(new RTCIceCandidate(c));
    } catch (err) {
      console.warn('Error sa pag-add ng naka-queue na ICE candidate:', err);
    }
  }
}

function hideIncomingCall() {
  incomingCallModal.classList.add('hidden');
  if (navigator.vibrate) navigator.vibrate(0);
  pendingCallFrom = null;
  pendingOffer = null;
}

function registerSocketCallHandlers() {
  socket.on('incoming-call', ({ from, offer, video }) => {
    // Abala na (may kausap o may nagri-ring pa) — sabihan ang tumatawag.
    if (peerConnection || (pendingCallFrom && pendingCallFrom !== from)) {
      socket.emit('call-busy', { to: from });
      return;
    }
    pendingCallFrom = from;
    pendingOffer = offer;
    pendingCallVideo = video !== false;
    queuedCandidates = [];
    const displayName = nameForUsername(from);
    callerName.textContent = displayName;
    callerAvatar.innerHTML = avatarInner(displayName, pictureForUsername(from));
    incomingCallLabel.textContent = pendingCallVideo ? 'Video calling...' : 'Voice calling...';
    incomingCallModal.classList.remove('hidden');
    if (navigator.vibrate) navigator.vibrate([600, 400, 600, 400, 600, 400, 600]);

    clearTimeout(ringTimer);
    ringTimer = setTimeout(() => {
      if (pendingCallFrom === from) {
        hideIncomingCall();
        showToast(`Missed call mula kay ${displayName}`, 5000);
      }
    }, RING_TIMEOUT_MS);
  });

  socket.on('call-answered', async ({ from, answer }) => {
    if (!peerConnection || from !== inCallWith) return;
    if (peerConnection.signalingState !== 'have-local-offer') return; // sinagot na sa ibang device
    clearTimeout(ringTimer);
    try {
      await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
      callStatus.textContent = 'Kumokonekta...';
      await flushQueuedCandidates();
    } catch (err) {
      console.error('Error sa pag-set ng answer:', err);
      showToast('Hindi maikonekta ang tawag. Subukan ulit.', 5000);
      endCall(true);
    }
  });

  socket.on('ice-candidate', async ({ from, candidate }) => {
    if (!candidate) return;
    if (from !== inCallWith && from !== pendingCallFrom) return;
    if (peerConnection && peerConnection.remoteDescription) {
      try {
        await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (err) {
        console.warn('Error sa pag-add ng ICE candidate:', err);
      }
    } else {
      queuedCandidates.push(candidate);
    }
  });

  socket.on('call-ended', ({ from }) => {
    if (from && from === pendingCallFrom) {
      // Ibinaba ng tumatawag habang nagri-ring pa sa atin
      const name = nameForUsername(from);
      hideIncomingCall();
      clearCallTimers();
      showToast(`Missed call mula kay ${name}`, 5000);
      return;
    }
    if (from && from !== inCallWith) return; // galing sa ibang tawag — huwag pansinin
    showToast('Natapos ang tawag.');
    endCall(false);
  });

  socket.on('call-busy', ({ from }) => {
    if (from !== inCallWith) return;
    showToast(`May ibang kausap si ${nameForUsername(from)}. Subukan ulit mamaya.`, 5000);
    endCall(false);
  });

  socket.on('call-unavailable', ({ to }) => {
    if (to !== inCallWith) return;
    showToast(`Offline si ${nameForUsername(to)} — hindi matawagan ngayon.`, 5000);
    endCall(false);
  });

  // Sinagot/tinanggihan na ang tawag sa ibang tab/device ng parehong account
  socket.on('call-handled-elsewhere', ({ with: other }) => {
    if (other === pendingCallFrom) {
      hideIncomingCall();
      clearCallTimers();
    }
  });
}

videoCallBtn.addEventListener('click', () => startCall(true));
voiceCallBtn.addEventListener('click', () => startCall(false));

async function getLocalMedia(withVideo) {
  try {
    return await navigator.mediaDevices.getUserMedia({ video: withVideo, audio: true });
  } catch (err) {
    if (!withVideo) throw err;
    // Kung ayaw gumana ng camera (ginagamit ng ibang app, walang permiso, atbp.),
    // ituloy na lang bilang voice call kaysa tuluyang pumalya ang tawag.
    console.warn('Hindi ma-access ang camera, audio na lang:', err);
    const stream = await navigator.mediaDevices.getUserMedia({ video: false, audio: true });
    showToast('Hindi ma-access ang camera — audio lang ang maipapadala.', 4000);
    return stream;
  }
}

function setupLocalPreview() {
  localVideo.srcObject = localStream;
  const hasVideo = localStream.getVideoTracks().length > 0;
  localVideo.classList.toggle('hidden', !hasVideo);
  if (hasVideo) attemptPlay(localVideo);
  toggleMicBtn.classList.remove('off');
  toggleCamBtn.classList.toggle('off', !hasVideo);
}

async function startCall(withVideo) {
  if (!currentChatUserId || peerConnection) return;
  if (!window.isSecureContext) {
    showToast('Kailangan ng HTTPS para gumana ang camera/mic.', 5000);
    return;
  }
  if (!onlineUsernames.has(currentChatUserId)) {
    showToast(`Offline si ${currentChatUserName} — hindi matawagan ngayon.`, 5000);
    return;
  }
  const target = currentChatUserId;
  try {
    localStream = await getLocalMedia(withVideo);
  } catch (err) {
    showToast('Hindi ma-access ang camera/mic: ' + err.message, 5000);
    return;
  }
  currentCallVideo = withVideo;
  inCallWith = target;
  queuedCandidates = [];
  setupLocalPreview();
  showCallOverlay(`Tumatawag kay ${nameForUsername(target)}...`);

  try {
    peerConnection = createPeerConnection(target);
    localStream.getTracks().forEach((track) => peerConnection.addTrack(track, localStream));
    // Siguraduhing may video "slot" pa rin para matanggap ang video ng kabila
    // kahit audio lang ang sa atin (hal. sira/naka-block ang camera natin).
    if (withVideo && localStream.getVideoTracks().length === 0) {
      peerConnection.addTransceiver('video', { direction: 'recvonly' });
    }

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    socket.emit('call-user', { to: target, offer: peerConnection.localDescription, video: withVideo });
  } catch (err) {
    console.error('Error sa pagsisimula ng tawag:', err);
    showToast('Hindi masimulan ang tawag: ' + err.message, 5000);
    endCall(true);
    return;
  }

  clearTimeout(ringTimer);
  ringTimer = setTimeout(() => {
    if (inCallWith === target && peerConnection && peerConnection.signalingState === 'have-local-offer') {
      showToast('Walang sumagot.', 4000);
      endCall(true);
    }
  }, RING_TIMEOUT_MS);
}

function createPeerConnection(targetUsername) {
  const pc = new RTCPeerConnection(ICE_SERVERS);

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('ice-candidate', { to: targetUsername, candidate: event.candidate });
    }
  };

  pc.ontrack = (event) => {
    let stream = event.streams && event.streams[0];
    if (!stream) {
      stream = remoteVideo.srcObject instanceof MediaStream ? remoteVideo.srcObject : new MediaStream();
      stream.addTrack(event.track);
    }
    if (remoteVideo.srcObject !== stream) remoteVideo.srcObject = stream;
    attemptPlay(remoteVideo);
  };

  pc.onconnectionstatechange = () => {
    if (pc !== peerConnection) return;
    switch (pc.connectionState) {
      case 'connected':
        clearTimeout(disconnectTimer);
        disconnectTimer = null;
        callStatus.textContent = currentCallVideo ? 'Nakakonekta' : 'Voice call • Nakakonekta';
        attemptPlay(remoteVideo);
        break;
      case 'disconnected':
        // Kadalasan pansamantala lang ito (hal. humina ang signal) — bigyan ng
        // palugit bago tuluyang ibaba ang tawag.
        callStatus.textContent = 'Nawawala ang koneksyon...';
        clearTimeout(disconnectTimer);
        disconnectTimer = setTimeout(() => {
          if (pc === peerConnection && pc.connectionState !== 'connected') {
            showToast('Naputol ang koneksyon.', 4000);
            endCall(true);
          }
        }, DISCONNECT_GRACE_MS);
        break;
      case 'failed':
        showToast(
          'Hindi makabuo ng koneksyon sa pagitan ng dalawang phone. Kung magkaiba kayo ng network/mobile data, kailangan ng TURN server (TURN_USERNAME/TURN_CREDENTIAL sa Render).',
          8000
        );
        endCall(true); // sabihan din ang kabila para hindi siya maiwang naka-itim na screen
        break;
      default:
        break;
    }
  };

  return pc;
}

// Ilang mobile browser (lalo na sa Chrome Android) ay nano-block ng autoplay
// kahit may "autoplay" attribute na — kailangan pa ng explicit na .play() call.
// Kung na-block pa rin, maghihintay ng tap kahit saan sa screen bago ulit subukan.
function attemptPlay(videoEl) {
  if (!videoEl.srcObject) return;
  const playPromise = videoEl.play();
  if (playPromise !== undefined) {
    playPromise.catch((err) => {
      if (err && err.name === 'AbortError') return; // napalitan lang ang srcObject, hindi problema
      console.warn('Na-block ang autoplay, maghihintay ng tap:', err);
      showToast('I-tap ang screen para mag-play ang video/audio.', 4000);
      const resumeOnTap = () => {
        videoEl.play().catch(() => {});
      };
      document.addEventListener('click', resumeOnTap, { once: true });
      document.addEventListener('touchend', resumeOnTap, { once: true });
    });
  }
}

acceptCallBtn.addEventListener('click', async () => {
  const from = pendingCallFrom;
  const offer = pendingOffer;
  const withVideo = pendingCallVideo;
  incomingCallModal.classList.add('hidden');
  if (navigator.vibrate) navigator.vibrate(0);
  clearTimeout(ringTimer);
  if (!from || !offer) return;

  if (!window.isSecureContext) {
    showToast('Kailangan ng HTTPS para gumana ang camera/mic.', 5000);
    socket.emit('end-call', { to: from });
    hideIncomingCall();
    return;
  }
  try {
    localStream = await getLocalMedia(withVideo);
  } catch (err) {
    showToast('Hindi ma-access ang camera/mic: ' + err.message, 5000);
    socket.emit('end-call', { to: from });
    hideIncomingCall();
    return;
  }
  // Baka ibinaba na ng tumatawag habang naghihintay tayo ng camera permission
  if (pendingCallFrom !== from) {
    localStream.getTracks().forEach((t) => t.stop());
    localStream = null;
    return;
  }

  currentCallVideo = withVideo;
  inCallWith = from;
  pendingCallFrom = null;
  pendingOffer = null;
  setupLocalPreview();
  showCallOverlay('Kumokonekta...');

  try {
    peerConnection = createPeerConnection(from);
    await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
    localStream.getTracks().forEach((track) => peerConnection.addTrack(track, localStream));
    await flushQueuedCandidates();
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    socket.emit('answer-call', { to: from, answer: peerConnection.localDescription });
  } catch (err) {
    console.error('Error sa pagsagot ng tawag:', err);
    showToast('Hindi masagot ang tawag: ' + err.message, 5000);
    endCall(true);
    return;
  }

  if (currentChatUserId !== from) {
    openChat(from, nameForUsername(from));
  }
});

declineCallBtn.addEventListener('click', () => {
  if (pendingCallFrom) socket.emit('end-call', { to: pendingCallFrom });
  hideIncomingCall();
  clearCallTimers();
  queuedCandidates = [];
});

function showCallOverlay(status) {
  videoCallOverlay.classList.remove('hidden');
  callStatus.textContent = status;
}

endCallBtn.addEventListener('click', () => endCall(true));

function endCall(notifyPeer) {
  if (notifyPeer && inCallWith && socket) {
    socket.emit('end-call', { to: inCallWith });
  }
  clearCallTimers();
  if (peerConnection) {
    const pc = peerConnection;
    peerConnection = null; // unahin para hindi na tumakbo ang onconnectionstatechange
    pc.ontrack = null;
    pc.onicecandidate = null;
    pc.onconnectionstatechange = null;
    pc.close();
  }
  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop());
    localStream = null;
  }
  remoteVideo.srcObject = null;
  localVideo.srcObject = null;
  videoCallOverlay.classList.add('hidden');
  toggleMicBtn.classList.remove('off');
  toggleCamBtn.classList.remove('off');
  queuedCandidates = [];
  inCallWith = null;
}

// Kapag isinara/ni-reload ang page habang may tawag, sabihan ang kabila.
window.addEventListener('pagehide', () => {
  if (inCallWith && socket) socket.emit('end-call', { to: inCallWith });
  else if (pendingCallFrom && socket) socket.emit('end-call', { to: pendingCallFrom });
});

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
  localVideo.classList.toggle('hidden', !videoTrack.enabled);
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
