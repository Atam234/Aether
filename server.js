// UMPAT Communication - Server
// Ito ang "utak" ng buong app. Pinapatakbo ito gamit ang: node server.js
// Gagana ito sa Termux, LAN, at Internet (kasama ang mga instructions sa README.md)

const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');
const https = require('https');
const { Server } = require('socket.io');

const app = express();
const PORT = process.env.PORT || 3000;

// --- Piliin kung HTTP o HTTPS gagamitin ---
// Kung meron cert.pem at key.pem (ginagawa ng generate-cert.sh), gagamit ng HTTPS.
// Kailangan ang HTTPS para gumana ang camera/mic pag nag-access ka gamit ang
// IP address ng device (halimbawa http://192.168.1.5:3000) sa halip na "localhost".
const certPath = path.join(__dirname, 'cert.pem');
const keyPath = path.join(__dirname, 'key.pem');

let server;
let usingHttps = false;

if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
  server = https.createServer(
    {
      cert: fs.readFileSync(certPath),
      key: fs.readFileSync(keyPath),
    },
    app
  );
  usingHttps = true;
} else {
  server = http.createServer(app);
}

const io = new Server(server, {
  cors: { origin: '*' },
});

app.use(express.static(path.join(__dirname, 'public')));

// --- Listahan ng mga online na user (nasa memory lang, mawawala kapag na-restart ang server) ---
// Map: socket.id -> username
const onlineUsers = new Map();

function broadcastUserList() {
  const users = Array.from(onlineUsers.entries()).map(([id, name]) => ({ id, name }));
  io.emit('user-list', users);
}

io.on('connection', (socket) => {
  console.log(`[+] Bagong koneksyon: ${socket.id}`);

  socket.on('join', (username) => {
    const cleanName = String(username || 'Anonymous').slice(0, 30);
    onlineUsers.set(socket.id, cleanName);
    console.log(`[+] Sumali si "${cleanName}" (${socket.id})`);
    broadcastUserList();
  });

  // --- Text Chat ---
  socket.on('chat-message', ({ to, message }) => {
    if (!to || !message) return;
    const fromName = onlineUsers.get(socket.id) || 'Unknown';
    io.to(to).emit('chat-message', {
      from: socket.id,
      fromName,
      message: String(message).slice(0, 2000),
      timestamp: Date.now(),
    });
  });

  // --- WebRTC Signaling (para sa video/voice call) ---
  socket.on('call-user', ({ to, offer }) => {
    const fromName = onlineUsers.get(socket.id) || 'Unknown';
    io.to(to).emit('incoming-call', { from: socket.id, fromName, offer });
  });

  socket.on('answer-call', ({ to, answer }) => {
    io.to(to).emit('call-answered', { from: socket.id, answer });
  });

  socket.on('ice-candidate', ({ to, candidate }) => {
    if (!to) return;
    io.to(to).emit('ice-candidate', { from: socket.id, candidate });
  });

  socket.on('end-call', ({ to }) => {
    if (!to) return;
    io.to(to).emit('call-ended', { from: socket.id });
  });

  socket.on('disconnect', () => {
    const name = onlineUsers.get(socket.id);
    onlineUsers.delete(socket.id);
    console.log(`[-] Umalis si "${name}" (${socket.id})`);
    broadcastUserList();
  });
});

server.listen(PORT, '0.0.0.0', () => {
  const proto = usingHttps ? 'https' : 'http';
  console.log('==================================================');
  console.log('  UMPAT Communication server - GUMAGANA NA!');
  console.log('==================================================');
  console.log(`  Protocol : ${proto.toUpperCase()}${usingHttps ? '' : '  (buo lang ang camera/mic sa "localhost")'}`);
  console.log(`  Lokal    : ${proto}://localhost:${PORT}`);
  console.log('  Tip: para makita ang IP address mo sa LAN, patakbuhin ang:');
  console.log('       ip addr show wlan0');
  console.log('  (basahin ang README.md para sa kumpletong instructions)');
  console.log('==================================================');
});
