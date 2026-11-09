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
        .then(() => showToast('Link copied!'))
        .catch(() => window.prompt('Copy this link:', url));
    } else {
      window.prompt('Copy this link:', url);
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
  if (!res.ok) throw new Error(data.error || 'Something went wrong.');
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
  authSubmitBtn.textContent = mode === 'login' ? 'Log in' : 'Create Account';
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
    authError.textContent = 'Please enter your username and password.';
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
    authError.textContent = 'Please enter your name.';
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
  authSubmitBtn.textContent = 'Join';
  authUsername.placeholder = 'Your name...';
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
    showToast('Could not verify your session: ' + err.message, 5000);
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
    const entry = {
      message: data.message,
      attachment: data.attachment || null,
      timestamp: data.timestamp,
      mine: data.from === getUsernameKey(),
    };
    addMessageToHistory(contact, entry);
    lastMessages[contact] = entry;
    if (contact === currentChatUserId) {
      renderMessages();
    } else if (data.from !== getUsernameKey()) {
      showToast(`New message from ${nameForUsername(data.from)}`);
      if (navigator.vibrate) navigator.vibrate(120);
    }
    if (data.from !== getUsernameKey()) {
      notifyUser(nameForUsername(data.from), previewForMessage(entry), 'msg-' + data.from, false);
    }
    renderContacts();
  });

  socket.on('chat-history', ({ withUser, messages }) => {
    chatHistory[withUser] = messages.map((m) => ({
      message: m.message,
      attachment: m.attachment || null,
      timestamp: m.timestamp,
      mine: m.from === getUsernameKey(),
    }));
    if (withUser === currentChatUserId) renderMessages();
  });

  registerSocketCallHandlers();
  requestNotificationPermission();

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
    showToast('Could not load contacts: ' + err.message, 5000);
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
  if (confirm('Are you sure you want to log out?')) logout();
});

// ---------- Contacts List ----------

const contactsList = document.getElementById('contacts-list');

function renderContacts() {
  if (registeredUsers.length === 0) {
    contactsList.innerHTML = '<div class="no-contacts">No other users yet. Ask the people you want to talk to to create an account too.</div>';
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
      ? (last.mine ? 'You: ' : '') + previewForMessage(last)
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
      messagesContainer.innerHTML = '<div class="no-contacts">Loading earlier messages...</div>';
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
    messagesContainer.innerHTML = '<div class="no-contacts">No messages yet. Say hello!</div>';
    return;
  }
  messagesContainer.innerHTML = msgs
    .map(
      (m) => `
    <div class="message-row ${m.mine ? 'mine' : 'theirs'}">
      ${m.attachment ? renderAttachment(m.attachment) : ''}
      ${m.message ? `<div class="message-bubble">${escapeHtml(m.message)}</div>` : ''}
    </div>
  `
    )
    .join('');
  messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

// ---------- Group Video/Voice Call (WebRTC mesh) ----------
// Bawat kalahok ay may sariling RTCPeerConnection papunta sa bawat isa.
// Ang bagong sumali ang gumagawa ng "offer" sa mga nasa tawag na.

const videoCallBtn = document.getElementById('video-call-btn');
const voiceCallBtn = document.getElementById('voice-call-btn');
const videoCallOverlay = document.getElementById('video-call-overlay');
const videoGrid = document.getElementById('video-grid');
const localVideo = document.getElementById('local-video');
const callStatus = document.getElementById('call-status');
const endCallBtn = document.getElementById('end-call-btn');
const toggleMicBtn = document.getElementById('toggle-mic-btn');
const toggleCamBtn = document.getElementById('toggle-cam-btn');
const addPersonBtn = document.getElementById('add-person-btn');

const incomingCallModal = document.getElementById('incoming-call-modal');
const callerName = document.getElementById('caller-name');
const callerAvatar = document.getElementById('caller-avatar');
const incomingCallLabel = document.getElementById('incoming-call-label');
const acceptCallBtn = document.getElementById('accept-call-btn');
const declineCallBtn = document.getElementById('decline-call-btn');

const addPersonModal = document.getElementById('add-person-modal');
const addPersonList = document.getElementById('add-person-list');

// Kasalukuyang tawag
let call = null; // { id, video, peers: Map(username -> {pc, tile, video, pendingIce}), invited: Set, everConnected }
let incoming = null; // { from, callId, video, participants }
let ringTimeout = null;
let noAnswerTimeout = null;

function registerSocketCallHandlers() {
  socket.on('incoming-call', ({ from, callId, video, participants }) => {
    if (call || incoming) {
      socket.emit('call-decline', { to: from, callId, reason: 'busy' });
      return;
    }
    incoming = { from, callId, video, participants: participants || [from] };
    const displayName = nameForUsername(from);
    callerName.textContent = displayName;
    callerAvatar.innerHTML = avatarInner(displayName, pictureForUsername(from));
    const others = incoming.participants.length - 1;
    incomingCallLabel.textContent =
      (video ? 'Video call' : 'Voice call') + (others > 0 ? ` • with ${others} other${others > 1 ? 's' : ''}` : '') + '...';
    incomingCallModal.classList.remove('hidden');
    startRinging();
    notifyUser(
      video ? 'Video call' : 'Voice call',
      `${displayName} is calling you`,
      'call-' + callId,
      true
    );
    // Kapag hindi sinagot sa loob ng 45 segundo
    clearTimeout(ringTimeout);
    ringTimeout = setTimeout(() => {
      if (incoming && incoming.callId === callId) {
        socket.emit('call-decline', { to: from, callId, reason: 'no-answer' });
        dismissIncoming();
        showToast(`Missed call from ${displayName}`);
      }
    }, 45000);
  });

  // Sinagot o tinanggihan na sa ibang device mo
  socket.on('call-handled', ({ callId }) => {
    if (incoming && incoming.callId === callId && !(call && call.id === callId)) dismissIncoming();
  });

  socket.on('call-peer-joined', ({ callId, username }) => {
    if (!call || call.id !== callId) return;
    call.invited.delete(username);
    ensurePeer(username); // hihintayin ang offer mula sa bagong sumali
    updateCallStatus();
  });

  socket.on('call-signal', async ({ from, callId, data }) => {
    if (!call || call.id !== callId || !data) return;
    const peer = ensurePeer(from);
    const pc = peer.pc;
    try {
      if (data.type === 'offer') {
        await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        await flushIce(peer);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('call-signal', { to: from, callId, data: { type: 'answer', sdp: pc.localDescription } });
      } else if (data.type === 'answer') {
        await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        await flushIce(peer);
      } else if (data.type === 'candidate' && data.candidate) {
        if (pc.remoteDescription) {
          await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
        } else {
          peer.pendingIce.push(data.candidate);
        }
      }
    } catch (err) {
      console.error('Signaling error:', err);
    }
  });

  socket.on('call-peer-left', ({ callId, username }) => {
    if (!call || call.id !== callId) return;
    removePeer(username);
    showToast(`${nameForUsername(username)} left the call.`);
    checkCallEmpty();
  });

  socket.on('call-declined', ({ from, callId, reason }) => {
    if (!call || call.id !== callId) return;
    call.invited.delete(from);
    const name = nameForUsername(from);
    const msg =
      reason === 'busy' ? `${name} is on another call.`
      : reason === 'offline' ? `${name} is offline.`
      : reason === 'no-answer' ? `${name} didn't answer.`
      : `${name} declined the call.`;
    showToast(msg);
    checkCallEmpty();
  });
}

videoCallBtn.addEventListener('click', () => startCall(true));
voiceCallBtn.addEventListener('click', () => startCall(false));

async function getMedia(withVideo) {
  if (!window.isSecureContext) {
    showToast('HTTPS is required for the camera/mic to work.', 5000);
    return null;
  }
  try {
    return await navigator.mediaDevices.getUserMedia({ video: withVideo, audio: true });
  } catch (err) {
    showToast('Could not access the camera/mic: ' + err.message, 5000);
    return null;
  }
}

async function startCall(withVideo) {
  if (!currentChatUserId || call) return;
  const target = currentChatUserId;
  localStream = await getMedia(withVideo);
  if (!localStream) return;

  const { callId } = await new Promise((resolve) => socket.emit('call-create', resolve));
  call = { id: callId, video: withVideo, peers: new Map(), invited: new Set(), everConnected: false };
  openCallOverlay(withVideo);
  inviteToCall(target);
}

function inviteToCall(username) {
  if (!call || call.peers.has(username) || call.invited.has(username)) return;
  call.invited.add(username);
  socket.emit('call-invite', { to: username, callId: call.id, video: call.video });
  updateCallStatus();
  // Kapag walang sumagot sa loob ng 50 segundo
  clearTimeout(noAnswerTimeout);
  noAnswerTimeout = setTimeout(() => {
    if (!call) return;
    call.invited.clear();
    if (call.peers.size === 0) {
      showToast('No one answered.');
      endCall();
    } else {
      updateCallStatus();
    }
  }, 50000);
}

acceptCallBtn.addEventListener('click', async () => {
  if (!incoming) return;
  const inv = incoming;
  dismissIncoming();
  localStream = await getMedia(inv.video);
  if (!localStream) {
    socket.emit('call-decline', { to: inv.from, callId: inv.callId });
    return;
  }
  call = { id: inv.callId, video: inv.video, peers: new Map(), invited: new Set(), everConnected: false };
  openCallOverlay(inv.video);
  callStatus.textContent = 'Connecting...';

  socket.emit('call-join', { callId: inv.callId }, async (res) => {
    if (!res || res.error) {
      showToast(res && res.error ? res.error : 'Could not join the call.');
      endCall();
      return;
    }
    // Ako ang bagong sumali: ako ang gagawa ng offer sa bawat kalahok
    for (const username of res.participants) {
      const peer = ensurePeer(username);
      try {
        const offer = await peer.pc.createOffer();
        await peer.pc.setLocalDescription(offer);
        socket.emit('call-signal', {
          to: username,
          callId: inv.callId,
          data: { type: 'offer', sdp: peer.pc.localDescription },
        });
      } catch (err) {
        console.error('Offer error:', err);
      }
    }
    updateCallStatus();
  });

  if (!currentChatUserId) openChat(inv.from, nameForUsername(inv.from));
});

declineCallBtn.addEventListener('click', () => {
  if (!incoming) return;
  socket.emit('call-decline', { to: incoming.from, callId: incoming.callId });
  dismissIncoming();
});

function dismissIncoming() {
  incomingCallModal.classList.add('hidden');
  stopRinging();
  clearTimeout(ringTimeout);
  if (incoming) cancelNotification('call-' + incoming.callId);
  incoming = null;
}

function ensurePeer(username) {
  if (call.peers.has(username)) return call.peers.get(username);

  const pc = new RTCPeerConnection(ICE_SERVERS);
  const tile = document.createElement('div');
  tile.className = 'video-tile';
  const name = nameForUsername(username);
  tile.innerHTML = `
    <div class="tile-avatar"><div class="avatar avatar-lg">${avatarInner(name, pictureForUsername(username))}</div></div>
    <video autoplay playsinline></video>
    <span class="tile-name">${escapeHtml(name)}</span>`;
  const video = tile.querySelector('video');
  videoGrid.appendChild(tile);

  const peer = { pc, tile, video, pendingIce: [] };
  call.peers.set(username, peer);
  layoutGrid();

  if (localStream) localStream.getTracks().forEach((t) => pc.addTrack(t, localStream));

  pc.onicecandidate = (e) => {
    if (e.candidate && call) {
      socket.emit('call-signal', { to: username, callId: call.id, data: { type: 'candidate', candidate: e.candidate } });
    }
  };
  pc.ontrack = (e) => {
    if (video.srcObject === e.streams[0]) return;
    video.srcObject = e.streams[0];
    attemptPlay(video);
    const hasVideo = e.streams[0].getVideoTracks().length > 0;
    tile.classList.toggle('has-video', hasVideo);
    e.streams[0].onaddtrack = () => tile.classList.toggle('has-video', e.streams[0].getVideoTracks().length > 0);
  };
  pc.onconnectionstatechange = () => {
    if (!call) return;
    if (pc.connectionState === 'connected') {
      call.everConnected = true;
      updateCallStatus();
    } else if (pc.connectionState === 'failed') {
      removePeer(username);
      showToast(`Lost connection to ${name}.`);
      checkCallEmpty();
    }
  };
  return peer;
}

async function flushIce(peer) {
  while (peer.pendingIce.length) {
    try {
      await peer.pc.addIceCandidate(new RTCIceCandidate(peer.pendingIce.shift()));
    } catch (err) {
      console.warn('ICE error:', err);
    }
  }
}

function removePeer(username) {
  if (!call) return;
  const peer = call.peers.get(username);
  if (!peer) return;
  peer.pc.close();
  peer.tile.remove();
  call.peers.delete(username);
  layoutGrid();
  updateCallStatus();
}

function checkCallEmpty() {
  if (call && call.peers.size === 0 && call.invited.size === 0) {
    if (call.everConnected) showToast('Call ended.');
    endCall();
  }
}

function layoutGrid() {
  const n = call ? call.peers.size : 0;
  videoGrid.dataset.count = String(Math.min(n, 6));
}

function updateCallStatus() {
  if (!call) return;
  const n = call.peers.size;
  const connected = Array.from(call.peers.values()).filter((p) => p.pc.connectionState === 'connected').length;
  if (n === 0) {
    callStatus.textContent = call.invited.size ? 'Calling...' : 'Waiting...';
  } else if (connected === 0) {
    callStatus.textContent = 'Connecting...';
  } else {
    callStatus.textContent = n === 1 ? 'Connected' : `Group call • ${n + 1} people`;
    if (call.invited.size) callStatus.textContent += ` • calling ${call.invited.size} more`;
  }
}

function openCallOverlay(withVideo) {
  localVideo.srcObject = localStream;
  attemptPlay(localVideo);
  localVideo.classList.toggle('hidden', !withVideo);
  toggleCamBtn.classList.toggle('hidden', !withVideo);
  toggleMicBtn.classList.remove('off');
  toggleCamBtn.classList.remove('off');
  videoGrid.innerHTML = '';
  layoutGrid();
  videoCallOverlay.classList.remove('hidden');
  callStatus.textContent = 'Calling...';
}

// Ilang mobile browser (lalo na sa Chrome Android) ay nano-block ng autoplay
// kahit may "autoplay" attribute na — kailangan pa ng explicit na .play() call.
// Kung na-block pa rin, maghihintay ng tap kahit saan sa screen bago ulit subukan.
function attemptPlay(videoEl) {
  const playPromise = videoEl.play();
  if (playPromise !== undefined) {
    playPromise.catch((err) => {
      // AbortError: napalitan lang ng bagong play() (hal. dumating ang audio at video track) — hindi problema
      if (err && err.name === 'AbortError') return;
      console.warn('Autoplay blocked, waiting for a tap:', err);
      showToast('Tap the screen to play video/audio.', 4000);
      const resumeOnTap = () => {
        videoEl.play().catch(() => {});
      };
      document.addEventListener('click', resumeOnTap, { once: true });
      document.addEventListener('touchend', resumeOnTap, { once: true });
    });
  }
}

endCallBtn.addEventListener('click', () => endCall());

function endCall() {
  if (!call) return;
  socket.emit('call-leave', { callId: call.id });
  call.peers.forEach((p) => p.pc.close());
  call = null;
  clearTimeout(noAnswerTimeout);
  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop());
    localStream = null;
  }
  localVideo.srcObject = null;
  videoGrid.innerHTML = '';
  videoCallOverlay.classList.add('hidden');
  addPersonModal.classList.add('hidden');
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

// --- Magdagdag ng tao sa tawag (group call) ---

addPersonBtn.addEventListener('click', () => {
  if (!call) return;
  const candidates = registeredUsers.filter(
    (u) => onlineUsernames.has(u.username) && !call.peers.has(u.username) && u.username !== myUsernameKey
  );
  if (candidates.length === 0) {
    addPersonList.innerHTML = '<div class="no-contacts">No one else is online to add.</div>';
  } else {
    addPersonList.innerHTML = '';
    candidates.forEach((u) => {
      const invited = call.invited.has(u.username);
      const row = document.createElement('div');
      row.className = 'contact-item';
      row.innerHTML = `
        <div class="avatar">${avatarInner(u.displayName, u.profilePicture)}</div>
        <div class="contact-info"><div class="contact-name">${escapeHtml(u.displayName)}</div>
        <div class="contact-preview"><span>${invited ? 'Calling...' : 'Online'}</span></div></div>
        <button class="settings-save-btn add-person-invite" type="button" ${invited ? 'disabled' : ''}>${invited ? 'Waiting' : 'Add'}</button>`;
      row.querySelector('button').addEventListener('click', () => {
        inviteToCall(u.username);
        addPersonModal.classList.add('hidden');
        showToast(`Calling ${u.displayName}...`);
      });
      addPersonList.appendChild(row);
    });
  }
  addPersonModal.classList.remove('hidden');
});

document.getElementById('close-add-person-btn').addEventListener('click', () => {
  addPersonModal.classList.add('hidden');
});

// --- Ringtone (gawa sa Web Audio, walang audio file na kailangan) ---

let ringCtx = null;
let ringTimer = null;

function startRinging() {
  stopRinging();
  try {
    ringCtx = new (window.AudioContext || window.webkitAudioContext)();
  } catch (e) {
    ringCtx = null;
  }
  const ringOnce = () => {
    if (navigator.vibrate) navigator.vibrate([400, 200, 400]);
    if (!ringCtx) return;
    if (ringCtx.state === 'suspended') ringCtx.resume().catch(() => {});
    [0, 0.45].forEach((offset) => {
      const t = ringCtx.currentTime + offset;
      const osc = ringCtx.createOscillator();
      const gain = ringCtx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, t);
      osc.frequency.setValueAtTime(660, t + 0.18);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.25, t + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.38);
      osc.connect(gain).connect(ringCtx.destination);
      osc.start(t);
      osc.stop(t + 0.4);
    });
  };
  ringOnce();
  ringTimer = setInterval(ringOnce, 2200);
}

function stopRinging() {
  clearInterval(ringTimer);
  ringTimer = null;
  if (navigator.vibrate) navigator.vibrate(0);
  if (ringCtx) {
    ringCtx.close().catch(() => {});
    ringCtx = null;
  }
}

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
    showSettingsStatus('Only images are allowed.');
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
    showSettingsStatus('Photo updated!', false);
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
    showSettingsStatus('Photo removed.', false);
  } catch (err) {
    showSettingsStatus(err.message);
  }
});

saveNameBtn.addEventListener('click', async () => {
  const newName = settingsDisplayName.value.trim();
  if (newName.length < 2) {
    showSettingsStatus('Must be at least 2 characters.');
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
    showSettingsStatus('Name saved!', false);
  } catch (err) {
    showSettingsStatus(err.message);
  }
});

// Ina-resize/kino-compress ang larawan gamit ang canvas bago i-upload,
// para maliit lang ang file size (mas mabilis mag-load sa mobile data).
function resizeImageToDataUrl(file, maxSize, quality) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read the file.'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Could not read the image.'));
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

// ---------- Pagpadala ng File / Larawan ----------

const attachBtn = document.getElementById('attach-btn');
const attachInput = document.getElementById('attach-input');
const uploadProgress = document.getElementById('upload-progress');
const uploadProgressBar = document.getElementById('upload-progress-bar');
const uploadProgressLabel = document.getElementById('upload-progress-label');

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function attachmentKind(a) {
  const mime = (a.mime || '').toLowerCase();
  const name = (a.name || '').toLowerCase();
  if (mime.startsWith('image/') && !mime.includes('svg')) return 'image';
  if (mime.startsWith('video/') || /\.(mp4|webm)$/.test(name)) return 'video';
  if (mime.startsWith('audio/') || /\.(mp3|m4a|ogg|wav)$/.test(name)) return 'audio';
  return 'file';
}

function previewForMessage(m) {
  if (m.message) return m.message;
  if (!m.attachment) return '';
  const kind = attachmentKind(m.attachment);
  if (kind === 'image') return '📷 Photo';
  if (kind === 'video') return '🎬 Video';
  if (kind === 'audio') return '🎵 Audio';
  return '📎 ' + m.attachment.name;
}

function renderAttachment(a) {
  const url = escapeHtml(a.url);
  const name = escapeHtml(a.name || 'file');
  switch (attachmentKind(a)) {
    case 'image':
      return `<div class="message-attachment"><img class="msg-image" src="${url}" alt="${name}" loading="lazy" data-full="${url}"></div>`;
    case 'video':
      return `<div class="message-attachment"><video class="msg-video" src="${url}" controls playsinline preload="metadata"></video></div>`;
    case 'audio':
      return `<div class="message-attachment"><audio class="msg-audio" src="${url}" controls preload="metadata"></audio></div>`;
    default:
      return `<a class="message-attachment msg-file" href="${url}?download=1" download="${name}">
        <span class="msg-file-icon"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg></span>
        <span class="msg-file-info"><span class="msg-file-name">${name}</span><span class="msg-file-size">${formatSize(a.size || 0)} • Download</span></span>
      </a>`;
  }
}

attachBtn.addEventListener('click', () => {
  if (!currentChatUserId) return;
  attachInput.click();
});

attachInput.addEventListener('change', async () => {
  const file = attachInput.files && attachInput.files[0];
  attachInput.value = '';
  if (!file || !currentChatUserId) return;
  const to = currentChatUserId;

  let blob = file;
  let name = file.name || 'file';
  let mime = file.type || 'application/octet-stream';
  // Kino-compress ang mga larawan (maliban sa GIF) para mabilis ipadala
  if (mime.startsWith('image/') && !/gif|svg/.test(mime)) {
    try {
      const dataUrl = await resizeImageToDataUrl(file, 1600, 0.85);
      blob = await (await fetch(dataUrl)).blob();
      mime = 'image/jpeg';
      name = name.replace(/\.[^.]+$/, '') + '.jpg';
    } catch (e) {
      // gamitin na lang ang orihinal
    }
  }
  if (blob.size > 25 * 1024 * 1024) {
    showToast('File is too large (max 25 MB).', 4000);
    return;
  }

  try {
    const att = await uploadFile(blob, name, mime);
    socket.emit('chat-message', { to, message: '', attachment: att });
  } catch (err) {
    showToast('Could not send: ' + err.message, 5000);
  }
});

function uploadFile(blob, name, mime) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('X-File-Name', encodeURIComponent(name));
    xhr.setRequestHeader('X-File-Type', mime);
    const token = localStorage.getItem('umpat_token');
    if (appMode !== 'guest' && token) xhr.setRequestHeader('Authorization', 'Bearer ' + token);

    uploadProgress.classList.remove('hidden');
    uploadProgressLabel.textContent = 'Sending ' + name + '...';
    uploadProgressBar.style.width = '0%';
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) uploadProgressBar.style.width = Math.round((e.loaded / e.total) * 100) + '%';
    };
    xhr.onload = () => {
      uploadProgress.classList.add('hidden');
      let data = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch (e) {}
      if (xhr.status >= 200 && xhr.status < 300 && data.url) resolve(data);
      else reject(new Error(data.error || 'Error ' + xhr.status));
    };
    xhr.onerror = () => {
      uploadProgress.classList.add('hidden');
      reject(new Error('No connection to the server.'));
    };
    xhr.send(blob);
  });
}

// --- Lightbox para sa larawan ---

const lightbox = document.getElementById('lightbox');
const lightboxImg = document.getElementById('lightbox-img');
const lightboxDownload = document.getElementById('lightbox-download');

messagesContainer.addEventListener('click', (e) => {
  const img = e.target.closest('.msg-image');
  if (!img) return;
  const url = img.getAttribute('data-full');
  lightboxImg.src = url;
  lightboxDownload.href = url + '?download=1';
  lightbox.classList.remove('hidden');
});

// Kapag nag-load ang larawan, i-scroll pababa (para hindi matakpan ang bagong mensahe)
messagesContainer.addEventListener('load', (e) => {
  if (e.target.classList && e.target.classList.contains('msg-image')) {
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }
}, true);

lightbox.addEventListener('click', (e) => {
  if (e.target.closest('#lightbox-download')) return;
  lightbox.classList.add('hidden');
  lightboxImg.src = '';
});

// ---------- Notifications ----------
// Sa APK: native na Android notification (UmpatBridge). Sa browser:
// Web Notification API habang nakatago/naka-minimize ang tab.

function hasNativeBridge() {
  return typeof window.UmpatBridge !== 'undefined' && typeof window.UmpatBridge.notify === 'function';
}

function requestNotificationPermission() {
  if (hasNativeBridge()) return; // ang APK na ang bahala
  if (!('Notification' in window) || !window.isSecureContext) return;
  if (Notification.permission === 'default') {
    // Hinihingi lang pagkatapos ng unang click (kailangan ng ibang browser)
    document.addEventListener('click', () => Notification.requestPermission().catch(() => {}), { once: true });
  }
}

const webNotifications = {};

function notifyUser(title, body, tag, isCall) {
  if (hasNativeBridge()) {
    try {
      window.UmpatBridge.notify(String(title), String(body), String(tag), !!isCall);
    } catch (e) {}
    return;
  }
  if (!document.hidden) return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const n = new Notification(title, { body, tag, renotify: true, requireInteraction: !!isCall });
    n.onclick = () => {
      window.focus();
      n.close();
    };
    webNotifications[tag] = n;
  } catch (e) {}
}

function cancelNotification(tag) {
  if (hasNativeBridge() && typeof window.UmpatBridge.cancelNotification === 'function') {
    try {
      window.UmpatBridge.cancelNotification(String(tag));
    } catch (e) {}
  }
  if (webNotifications[tag]) {
    webNotifications[tag].close();
    delete webNotifications[tag];
  }
}
