// UMPAT Communication - Server (v2: may permanent accounts + persistent chat history)
// Kailangan ng dalawang Environment Variable sa Render: MONGODB_URI at JWT_SECRET
// (basahin ang SETUP-ACCOUNTS-SOP.md para sa buong instructions)

const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const path = require('path');
const express = require('express');
const http = require('http');
const https = require('https');
const { Server } = require('socket.io');
const { MongoClient } = require('mongodb');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'umpat-dev-secret-PALITAN-MO-ITO-SA-RENDER';
const MONGODB_URI = process.env.MONGODB_URI;

app.use(express.json({ limit: '2mb' }));

// --- Piliin kung HTTP o HTTPS gagamitin (tulad ng dati) ---
const certPath = path.join(__dirname, 'cert.pem');
const keyPath = path.join(__dirname, 'key.pem');
let server;
let usingHttps = false;

if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
  server = https.createServer(
    { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) },
    app
  );
  usingHttps = true;
} else {
  server = http.createServer(app);
}

const io = new Server(server, { cors: { origin: '*' } });
app.use(express.static(path.join(__dirname, 'public')));

// ============ MongoDB ============

let usersCollection = null;
let messagesCollection = null;

async function connectDB() {
  if (!MONGODB_URI) {
    console.warn('[!] Walang MONGODB_URI na environment variable.');
    console.warn('[!] Gagana ang app pero HINDI PERMANENTE ang accounts/chat history.');
    return;
  }
  try {
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    const db = client.db('umpat_communication');
    usersCollection = db.collection('users');
    messagesCollection = db.collection('messages');
    await usersCollection.createIndex({ username: 1 }, { unique: true });
    await messagesCollection.createIndex({ from: 1, to: 1, timestamp: 1 });
    console.log('[+] Konektado sa MongoDB Atlas — permanente na ang accounts at chat history.');
  } catch (err) {
    console.error('[!] Hindi makakonekta sa MongoDB:', err.message);
  }
}
connectDB();

function dbReady(res) {
  if (!usersCollection) {
    res.status(503).json({
      error: 'Hindi pa naka-configure ang database. Basahin ang SETUP-ACCOUNTS-SOP.md.',
    });
    return false;
  }
  return true;
}

// Pampublikong endpoint para malaman ng client kung full-account mode ba
// tayo (may database, online/Render) o Guest/LAN mode (walang database,
// hal. tumatakbo lang via Termux sa loob ng LAN nang walang MongoDB setup).
// Ginagamit din ito ng UMPAT Android app para mahanap ang server sa LAN
// (LAN Scan), kaya may "app" at "name" na kasama.
app.get('/api/mode', (req, res) => {
  res.json({
    app: 'umpat',
    name: process.env.SERVER_NAME || os.hostname(),
    https: usingHttps,
    hasDatabase: !!usersCollection,
  });
});

// Lahat ng IPv4 address ng device na ito sa LAN (Wi-Fi / hotspot / ethernet)
function getLanAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const addr of ifaces[name] || []) {
      if (addr.family === 'IPv4' && !addr.internal) out.push(addr.address);
    }
  }
  return out;
}

// ============ Auth REST endpoints ============

app.post('/api/register', async (req, res) => {
  if (!dbReady(res)) return;
  try {
    const { username, password } = req.body || {};
    if (!username || !password || username.trim().length < 3 || password.length < 4) {
      return res.status(400).json({
        error: 'Kailangan ng username (min. 3 letra) at password (min. 4 letra).',
      });
    }
    const cleanUsername = username.trim();
    const key = cleanUsername.toLowerCase();
    const existing = await usersCollection.findOne({ username: key });
    if (existing) {
      return res.status(400).json({ error: 'Kuha na ang username na iyan. Pumili ng iba.' });
    }
    const passwordHash = await bcrypt.hash(password, 10);
    await usersCollection.insertOne({
      username: key,
      displayName: cleanUsername,
      passwordHash,
      createdAt: new Date(),
    });
    const token = jwt.sign({ username: key }, JWT_SECRET, { expiresIn: '365d' });
    res.json({ token, username: cleanUsername });
  } catch (err) {
    console.error('Register error:', err.message);
    res.status(500).json({ error: 'May error sa server. Subukan ulit.' });
  }
});

app.post('/api/login', async (req, res) => {
  if (!dbReady(res)) return;
  try {
    const { username, password } = req.body || {};
    const key = String(username || '').trim().toLowerCase();
    const user = await usersCollection.findOne({ username: key });
    if (!user) return res.status(400).json({ error: 'Walang account na may ganitong username.' });
    const match = await bcrypt.compare(password || '', user.passwordHash);
    if (!match) return res.status(400).json({ error: 'Maling password.' });
    const token = jwt.sign({ username: user.username }, JWT_SECRET, { expiresIn: '365d' });
    res.json({ token, username: user.displayName });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ error: 'May error sa server. Subukan ulit.' });
  }
});

function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Kailangan mag-login.' });
  try {
    req.username = jwt.verify(token, JWT_SECRET).username;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Expired o invalid ang session. Mag-login ulit.' });
  }
}

// ============ File / Image uploads ============
// Naka-save sa "uploads" folder. Sa Termux (LAN) permanente ito; sa Render
// free tier, nabubura ito kapag nag-restart/redeploy ang server.

const UPLOAD_DIR = path.join(__dirname, 'uploads');
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25 MB
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Mga file na ligtas ipakita sa loob ng app (hindi kayang magpatakbo ng script)
const INLINE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.mp4', '.webm', '.mp3', '.m4a', '.ogg', '.wav']);

app.use(
  '/uploads',
  express.static(UPLOAD_DIR, {
    maxAge: '7d',
    setHeaders(res, filePath) {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      const ext = path.extname(filePath).toLowerCase();
      if (!INLINE_EXT.has(ext) || res.req.query.download) {
        res.setHeader('Content-Disposition', 'attachment');
      }
    },
  })
);

// Sa online mode (may database) kailangan naka-login; sa LAN/guest mode, bukas.
function uploadAuth(req, res, next) {
  if (!usersCollection) return next();
  return authMiddleware(req, res, next);
}

function safeFileName(name) {
  const base = path.basename(String(name || 'file'));
  const clean = base.replace(/[^\w.\- ()]+/g, '_').replace(/^\.+/, '').slice(-80);
  return clean || 'file';
}

app.post(
  '/api/upload',
  uploadAuth,
  express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES }),
  (req, res) => {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ error: 'Walang laman ang file.' });
    }
    let original = 'file';
    try {
      original = decodeURIComponent(req.headers['x-file-name'] || 'file');
    } catch (e) {}
    const name = safeFileName(original);
    const stored = crypto.randomBytes(8).toString('hex') + '-' + name;
    fs.writeFile(path.join(UPLOAD_DIR, stored), req.body, (err) => {
      if (err) {
        console.error('Upload error:', err.message);
        return res.status(500).json({ error: 'Hindi ma-save ang file.' });
      }
      res.json({
        url: '/uploads/' + encodeURIComponent(stored),
        name,
        size: req.body.length,
        mime: String(req.headers['x-file-type'] || 'application/octet-stream').slice(0, 100),
      });
    });
  }
);

// Error kapag sobrang laki ng file
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Masyadong malaki ang file (max 25 MB).' });
  }
  next(err);
});

function cleanAttachment(a) {
  if (!a || typeof a !== 'object') return null;
  const url = String(a.url || '');
  if (!/^\/uploads\/[\w%.\-()]+$/.test(url)) return null;
  return {
    url,
    name: safeFileName(a.name),
    size: Number(a.size) || 0,
    mime: String(a.mime || 'application/octet-stream').slice(0, 100),
  };
}

app.get('/api/ice-servers', authMiddleware, (req, res) => {
  const iceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ];
  // Kung naka-configure ang TURN_USERNAME/TURN_CREDENTIAL (galing sa ExpressTurn
  // o kahit anong TURN provider), idinadagdag ito bilang "relay" na fallback —
  // kailangan ito para gumana ang video call sa mobile data at ibang mahigpit
  // na network kung saan hindi sapat ang STUN lang.
  if (process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
    iceServers.push(
      {
        urls: 'turn:free.expressturn.com:3478',
        username: process.env.TURN_USERNAME,
        credential: process.env.TURN_CREDENTIAL,
      },
      {
        urls: 'turn:free.expressturn.com:3478?transport=tcp',
        username: process.env.TURN_USERNAME,
        credential: process.env.TURN_CREDENTIAL,
      }
    );
  }
  res.json({ iceServers });
});

app.get('/api/users', authMiddleware, async (req, res) => {
  if (!dbReady(res)) return;
  const users = await usersCollection
    .find({ username: { $ne: req.username } })
    .project({ username: 1, displayName: 1, profilePicture: 1, _id: 0 })
    .toArray();
  res.json(users);
});

app.get('/api/me', authMiddleware, async (req, res) => {
  if (!dbReady(res)) return;
  const user = await usersCollection.findOne(
    { username: req.username },
    { projection: { username: 1, displayName: 1, profilePicture: 1, _id: 0 } }
  );
  if (!user) return res.status(404).json({ error: 'Hindi mahanap ang account.' });
  res.json(user);
});

app.post('/api/profile', authMiddleware, async (req, res) => {
  if (!dbReady(res)) return;
  try {
    const { displayName, profilePicture } = req.body || {};
    const update = {};
    if (typeof displayName === 'string' && displayName.trim().length >= 2) {
      update.displayName = displayName.trim().slice(0, 24);
    }
    if (typeof profilePicture === 'string') {
      if (profilePicture.length > 800000) {
        return res.status(400).json({ error: 'Masyadong malaki ang larawan. Subukan ng ibang picture.' });
      }
      update.profilePicture = profilePicture; // pwedeng '' para i-clear/tanggalin
    }
    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'Walang binago.' });
    }
    await usersCollection.updateOne({ username: req.username }, { $set: update });
    const user = await usersCollection.findOne(
      { username: req.username },
      { projection: { username: 1, displayName: 1, profilePicture: 1, _id: 0 } }
    );
    res.json(user);
  } catch (err) {
    console.error('Profile update error:', err.message);
    res.status(500).json({ error: 'May error sa server.' });
  }
});

app.get('/api/last-messages', authMiddleware, async (req, res) => {
  if (!dbReady(res)) return;
  const messages = await messagesCollection
    .find({ $or: [{ from: req.username }, { to: req.username }] })
    .sort({ timestamp: -1 })
    .limit(500)
    .toArray();
  const lastByContact = {};
  for (const m of messages) {
    const contact = m.from === req.username ? m.to : m.from;
    if (!lastByContact[contact]) {
      lastByContact[contact] = {
        message: m.message,
        attachment: m.attachment || null,
        timestamp: m.timestamp,
        mine: m.from === req.username,
      };
    }
  }
  res.json(lastByContact);
});

// ============ Socket.io (JWT kapag may account, o guest name kapag LAN mode) ============

io.use((socket, next) => {
  const token = socket.handshake.auth && socket.handshake.auth.token;
  const guestName = socket.handshake.auth && socket.handshake.auth.guestName;

  if (token) {
    try {
      socket.username = jwt.verify(token, JWT_SECRET).username;
      socket.displayName = socket.username;
      socket.isGuest = false;
      return next();
    } catch (err) {
      return next(new Error('Invalid o expired session.'));
    }
  }

  // Guest/LAN mode — walang database, basta pangalan lang, walang password.
  const cleanName = String(guestName || '').trim();
  if (cleanName.length >= 1) {
    socket.username = cleanName.toLowerCase().slice(0, 24);
    socket.displayName = cleanName.slice(0, 24);
    socket.isGuest = true;
    return next();
  }

  next(new Error('Kailangan mag-login o maglagay ng pangalan.'));
});

// username -> Set ng socket.id (sakaling maraming tabs/devices)
const socketsByUsername = new Map();
// username -> displayName (kailangan lalo na sa Guest/LAN mode na walang database)
const displayNameByUsername = new Map();

function broadcastOnlineUsers() {
  const list = Array.from(socketsByUsername.keys()).map((u) => ({
    username: u,
    displayName: displayNameByUsername.get(u) || u,
  }));
  io.emit('online-users', list);
}

// callId -> Set ng username na nasa tawag
const calls = new Map();

function leaveCall(callId, username) {
  const room = calls.get(callId);
  if (!room || !room.has(username)) return;
  room.delete(username);
  room.forEach((u) => sendToUser(u, 'call-peer-left', { callId, username }));
  if (room.size === 0) calls.delete(callId);
}

function sendToUser(username, event, payload) {
  const sockets = socketsByUsername.get(username);
  if (sockets) sockets.forEach((sid) => io.to(sid).emit(event, payload));
}

io.on('connection', (socket) => {
  const username = socket.username;
  console.log(`[+] Kumonekta: ${username} (${socket.id})`);

  if (!socketsByUsername.has(username)) socketsByUsername.set(username, new Set());
  socketsByUsername.get(username).add(socket.id);
  displayNameByUsername.set(username, socket.displayName || username);
  broadcastOnlineUsers();

  // --- Chat history ---
  socket.on('get-history', async ({ withUser }) => {
    if (!messagesCollection || !withUser) return;
    const history = await messagesCollection
      .find({
        $or: [
          { from: username, to: withUser },
          { from: withUser, to: username },
        ],
      })
      .sort({ timestamp: 1 })
      .limit(300)
      .toArray();
    socket.emit('chat-history', { withUser, messages: history });
  });

  // --- Text Chat (naka-save na sa database ngayon) ---
  socket.on('chat-message', async ({ to, message, attachment } = {}) => {
    const att = cleanAttachment(attachment);
    if (!to || (!message && !att)) return;
    const doc = { from: username, to, message: String(message || '').slice(0, 2000), timestamp: Date.now() };
    if (att) doc.attachment = att;
    if (messagesCollection) {
      try {
        await messagesCollection.insertOne(doc);
      } catch (err) {
        console.error('Error sa pag-save ng mensahe:', err.message);
      }
    }
    sendToUser(to, 'chat-message', doc);
    sendToUser(username, 'chat-message', doc); // ibalik din sa sarili para makita ang sariling mensahe
  });

  // --- Group Call (WebRTC mesh): bawat kalahok ay may direktang koneksyon
  // sa bawat isa. Ang server ay tagapasa lang ng signaling. ---

  socket.on('call-create', (ack) => {
    const callId = crypto.randomBytes(6).toString('hex');
    calls.set(callId, new Set([username]));
    if (typeof ack === 'function') ack({ callId });
  });

  socket.on('call-invite', ({ to, callId, video } = {}) => {
    const room = calls.get(callId);
    if (!room || !room.has(username) || !to || room.has(to)) return;
    if (!socketsByUsername.has(to)) {
      socket.emit('call-declined', { from: to, callId, reason: 'offline' });
      return;
    }
    sendToUser(to, 'incoming-call', {
      from: username,
      callId,
      video: !!video,
      participants: Array.from(room),
    });
  });

  socket.on('call-join', ({ callId } = {}, ack) => {
    const room = calls.get(callId);
    if (!room) {
      if (typeof ack === 'function') ack({ error: 'Tapos na ang tawag.' });
      return;
    }
    const others = Array.from(room).filter((u) => u !== username);
    room.add(username);
    others.forEach((u) => sendToUser(u, 'call-peer-joined', { callId, username }));
    // Ibang device ng parehong user: itigil ang pag-ring
    sendToUser(username, 'call-handled', { callId });
    if (typeof ack === 'function') ack({ participants: others });
  });

  socket.on('call-signal', ({ to, callId, data } = {}) => {
    const room = calls.get(callId);
    if (!room || !room.has(username) || !room.has(to)) return;
    sendToUser(to, 'call-signal', { from: username, callId, data });
  });

  socket.on('call-decline', ({ to, callId, reason } = {}) => {
    sendToUser(to, 'call-declined', { from: username, callId, reason: reason || 'declined' });
    sendToUser(username, 'call-handled', { callId });
  });

  socket.on('call-leave', ({ callId } = {}) => leaveCall(callId, username));

  socket.on('disconnect', () => {
    const set = socketsByUsername.get(username);
    if (set) {
      set.delete(socket.id);
      if (set.size === 0) {
        socketsByUsername.delete(username);
        displayNameByUsername.delete(username);
        for (const [callId, room] of calls) {
          if (room.has(username)) leaveCall(callId, username);
        }
      }
    }
    broadcastOnlineUsers();
    console.log(`[-] Umalis: ${username}`);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  const proto = usingHttps ? 'https' : 'http';
  console.log('==================================================');
  console.log('  UMPAT Communication server - GUMAGANA NA!');
  console.log('==================================================');
  console.log(`  Protocol : ${proto.toUpperCase()}`);
  console.log(`  Lokal    : ${proto}://localhost:${PORT}`);
  getLanAddresses().forEach((ip) => {
    console.log(`  LAN      : ${proto}://${ip}:${PORT}`);
  });
  console.log(`  Database : ${MONGODB_URI ? 'Naka-configure' : 'WALANG MONGODB_URI'}`);
  console.log(
    `  TURN     : ${
      process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL ? 'Naka-configure' : 'WALANG TURN_USERNAME/TURN_CREDENTIAL'
    }`
  );
  console.log('==================================================');
});
