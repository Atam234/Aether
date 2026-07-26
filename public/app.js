// ============ UMPAT Communication — Client Logic ============

const socket = io();

let myUsername = '';
let currentChatUserId = null;
let currentChatUserName = null;
let onlineUsersList = [];
let localStream = null;
let peerConnection = null;
let pendingCallFrom = null;
let pendingCallFromName = null;
let pendingOffer = null;
let inCallWith = null;

const chatHistory = {}; // userId -> array of {message, timestamp, mine}

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

// ---------- Join Screen ----------

const joinScreen = document.getElementById('join-screen');
const usernameInput = document.getElementById('username-input');
const joinBtn = document.getElementById('join-btn');
const joinError = document.getElementById('join-error');
const appEl = document.getElementById('app');
const myAvatar = document.getElementById('my-avatar');
const myNameLabel = document.getElementById('my-name-label');

joinBtn.addEventListener('click', joinChat);
usernameInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') joinChat();
});

function joinChat() {
  const name = usernameInput.value.trim();
  if (!name) {
    joinError.classList.remove('hidden');
    return;
  }
  myUsername = name;
  socket.emit('join', name);
  joinScreen.classList.add('hidden');
  appEl.classList.remove('hidden');
  myAvatar.textContent = getInitials(name);
  myNameLabel.textContent = name;
}

// ---------- Contacts List ----------

const contactsList = document.getElementById('contacts-list');

socket.on('user-list', (users) => {
  onlineUsersList = users.filter((u) => u.id !== socket.id);
  renderContacts();
});

function renderContacts() {
  if (onlineUsersList.length === 0) {
    contactsList.innerHTML = '<div class="no-contacts">Walang ibang online na user sa ngayon. Buksan ang app na ito sa ibang device na nasa parehong network.</div>';
    return;
  }
  contactsList.innerHTML = '';
  onlineUsersList.forEach((user) => {
    const div = document.createElement('div');
    div.className = 'contact-item' + (user.id === currentChatUserId ? ' active' : '');
    div.innerHTML = `
      <div class="avatar">${getInitials(user.name)}<span class="online-dot"></span></div>
      <div class="contact-info">
        <div class="contact-name">${escapeHtml(user.name)}</div>
        <div class="contact-preview">Online</div>
      </div>
    `;
    div.addEventListener('click', () => openChat(user.id, user.name));
    contactsList.appendChild(div);
  });
}

// ---------- Chat Window ----------

const noChatSelected = document.getElementById('no-chat-selected');
const chatWindow = document.getElementById('chat-window');
const chatContactName = document.getElementById('chat-contact-name');
const chatAvatar = document.getElementById('chat-avatar');
const messagesContainer = document.getElementById('messages-container');
const messageInput = document.getElementById('message-input');
const sendBtn = document.getElementById('send-btn');
const backBtn = document.getElementById('back-btn');

function openChat(userId, userName) {
  currentChatUserId = userId;
  currentChatUserName = userName;
  noChatSelected.classList.add('hidden');
  chatWindow.classList.remove('hidden');
  chatContactName.textContent = userName;
  chatAvatar.textContent = getInitials(userName);
  appEl.classList.add('chat-open');
  renderContacts();
  renderMessages();
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
  addMessageToHistory(currentChatUserId, { message: text, timestamp: Date.now(), mine: true });
  messageInput.value = '';
  renderMessages();
}

socket.on('chat-message', (data) => {
  addMessageToHistory(data.from, {
    message: data.message,
    timestamp: data.timestamp,
    mine: false,
  });
  if (data.from === currentChatUserId) {
    renderMessages();
  } else {
    showToast(`Bagong mensahe mula kay ${data.fromName}`);
  }
});

function addMessageToHistory(userId, msg) {
  if (!chatHistory[userId]) chatHistory[userId] = [];
  chatHistory[userId].push(msg);
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

// ---------- Video Call (WebRTC) ----------

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

videoCallBtn.addEventListener('click', () => startCall(true));
voiceCallBtn.addEventListener('click', () => startCall(false));

async function startCall(withVideo) {
  if (!currentChatUserId) return;
  if (!window.isSecureContext) {
    showToast('Kailangan ng HTTPS o localhost para gumana ang camera/mic. Basahin ang README.md.', 6000);
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

function createPeerConnection(targetId) {
  const pc = new RTCPeerConnection(ICE_SERVERS);

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('ice-candidate', { to: targetId, candidate: event.candidate });
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

socket.on('incoming-call', async ({ from, fromName, offer }) => {
  if (peerConnection) {
    // Busy na sa ibang tawag — awtomatikong tanggihan
    io_emitEndCall(from);
    return;
  }
  pendingCallFrom = from;
  pendingCallFromName = fromName;
  pendingOffer = offer;
  callerName.textContent = fromName;
  callerAvatar.textContent = getInitials(fromName);
  incomingCallLabel.textContent = 'Video calling...';
  incomingCallModal.classList.remove('hidden');
});

function io_emitEndCall(to) {
  socket.emit('end-call', { to });
}

acceptCallBtn.addEventListener('click', async () => {
  incomingCallModal.classList.add('hidden');
  if (!window.isSecureContext) {
    showToast('Kailangan ng HTTPS o localhost para gumana ang camera/mic. Basahin ang README.md.', 6000);
    io_emitEndCall(pendingCallFrom);
    pendingCallFrom = null;
    pendingOffer = null;
    return;
  }
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  } catch (err) {
    showToast('Hindi ma-access ang camera/mic: ' + err.message, 5000);
    io_emitEndCall(pendingCallFrom);
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
    openChat(pendingCallFrom, pendingCallFromName);
  }

  pendingCallFrom = null;
  pendingOffer = null;
});

declineCallBtn.addEventListener('click', () => {
  incomingCallModal.classList.add('hidden');
  if (pendingCallFrom) io_emitEndCall(pendingCallFrom);
  pendingCallFrom = null;
  pendingOffer = null;
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

function showCallOverlay(status) {
  videoCallOverlay.classList.remove('hidden');
  callStatus.textContent = status;
}

endCallBtn.addEventListener('click', () => endCall(true));

function endCall(notifyPeer) {
  if (notifyPeer && inCallWith) {
    io_emitEndCall(inCallWith);
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

// ---------- Search filter (simpleng client-side filter) ----------

const searchInput = document.getElementById('search-input');
searchInput.addEventListener('input', () => {
  const q = searchInput.value.trim().toLowerCase();
  const filtered = q
    ? onlineUsersList.filter((u) => u.name.toLowerCase().includes(q))
    : onlineUsersList;
  const original = onlineUsersList;
  onlineUsersList = filtered;
  renderContacts();
  onlineUsersList = original;
});
