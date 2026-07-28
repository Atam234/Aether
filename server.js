// UMPAT Communication - Server (v2: may permanent accounts + persistent chat history)
// Kailangan ng dalawang Environment Variable sa Render: MONGODB_URI at JWT_SECRET
// (basahin ang SETUP-ACCOUNTS-SOP.md para sa buong instructions)

const fs = require('fs');
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
        timestamp: m.timestamp,
        mine: m.from === req.username,
      };
    }
  }
  res.json(lastByContact);
});

// ============ Socket.io (auth via JWT, hindi na basta-basta username) ============

io.use((socket, next) => {
  try {
    const token = socket.handshake.auth && socket.handshake.auth.token;
    if (!token) return next(new Error('Kailangan mag-login.'));
    socket.username = jwt.verify(token, JWT_SECRET).username;
    next();
  } catch (err) {
    next(new Error('Invalid o expired session.'));
  }
});

// username -> Set ng socket.id (sakaling maraming tabs/devices)
const socketsByUsername = new Map();

function broadcastOnlineUsers() {
  io.emit('online-users', Array.from(socketsByUsername.keys()));
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
  socket.on('chat-message', async ({ to, message }) => {
    if (!to || !message) return;
    const doc = { from: username, to, message: String(message).slice(0, 2000), timestamp: Date.now() };
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

  // --- WebRTC Signaling (by username na, hindi socket id) ---
  socket.on('call-user', ({ to, offer }) => {
    sendToUser(to, 'incoming-call', { from: username, offer });
  });

  socket.on('answer-call', ({ to, answer }) => {
    sendToUser(to, 'call-answered', { from: username, answer });
  });

  socket.on('ice-candidate', ({ to, candidate }) => {
    sendToUser(to, 'ice-candidate', { from: username, candidate });
  });

  socket.on('end-call', ({ to }) => {
    sendToUser(to, 'call-ended', { from: username });
  });

  socket.on('disconnect', () => {
    const set = socketsByUsername.get(username);
    if (set) {
      set.delete(socket.id);
      if (set.size === 0) socketsByUsername.delete(username);
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
  console.log(`  Database : ${MONGODB_URI ? 'Naka-configure' : 'WALANG MONGODB_URI'}`);
  console.log('==================================================');
});
