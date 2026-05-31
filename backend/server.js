'use strict';

require('dotenv').config();

const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const cors     = require('cors');
const path     = require('path');

const lm = require('./lobbyManager');

const PORT        = process.env.PORT        || 3000;
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

// --- Express -------------------------------------------------------------

const app = express();
app.use(cors({ origin: CORS_ORIGIN }));

// Serve frontend from project root (one level up)
app.use(express.static(path.join(__dirname, '..')));

const server = http.createServer(app);

// --- Socket.io -----------------------------------------------------------

const io = new Server(server, {
  cors: { origin: CORS_ORIGIN, methods: ['GET', 'POST'] },
});

io.on('connection', (socket) => {
  // -----------------------------------------------------------------------
  // Lobby lifecycle
  // -----------------------------------------------------------------------

  socket.on('lobby:start', () => {
    const lobby  = lm.createLobby();
    const player = lm.addPlayer(lobby, socket.id);
    socket.join(lobby.token);
    socket.emit('lobby:state', lm.lobbySnapshot(lobby, socket.id));
    // no playerJoined broadcast — first player, nobody else to notify
  });

  socket.on('lobby:join', ({ token } = {}) => {
    if (!token) return socket.emit('lobby:error', { message: 'Token required.' });
    const lobby = lm.getLobby(String(token).toUpperCase());
    if (!lobby) return socket.emit('lobby:error', { message: 'Lobby not found.' });
    const player = lm.addPlayer(lobby, socket.id);
    socket.join(lobby.token);
    socket.emit('lobby:state', lm.lobbySnapshot(lobby, socket.id));
    socket.to(lobby.token).emit('lobby:playerJoined', {
      socketId: socket.id,
      username: player.username,
      color:    player.color,
    });
  });

  socket.on('disconnect', () => {
    const lobby = lm.removePlayer(socket.id);
    if (lobby) {
      io.to(lobby.token).emit('lobby:playerLeft', { socketId: socket.id });
    }
  });

  // -----------------------------------------------------------------------
  // Player
  // -----------------------------------------------------------------------

  socket.on('player:rename', ({ username } = {}) => {
    if (!username || typeof username !== 'string') return;
    const trimmed = username.trim().slice(0, 32);
    if (!trimmed) return;
    const ok = lm.renamePlayer(socket.id, trimmed);
    if (!ok) return;
    const lobby = lm.lobbyForSocket(socket.id);
    io.to(lobby.token).emit('player:renamed', { socketId: socket.id, username: trimmed });
  });

  // -----------------------------------------------------------------------
  // Objects — AD-4, AD-5
  // -----------------------------------------------------------------------

  socket.on('object:add', ({ type, x, y, label } = {}) => {
    const lobby = lm.lobbyForSocket(socket.id);
    if (!lobby) return;
    let obj;
    try { obj = lm.addObject(lobby, { type, x, y, label }); }
    catch { return; }
    io.to(lobby.token).emit('object:added', obj);
  });

  // Grab — AD-2: server is authoritative lock owner
  socket.on('object:grab', ({ id } = {}) => {
    const lobby = lm.lobbyForSocket(socket.id);
    if (!lobby || !id) return;
    const result = lm.grabObject(lobby, id, socket.id);
    if (result.granted) {
      socket.emit('object:grabGranted', { id });
      // broadcast to everyone (incl. grabber) for lock indicator + z-update (AD-5)
      io.to(lobby.token).emit('object:grabbed', { id, socketId: socket.id, z: result.z });
    } else {
      socket.emit('object:grabDenied', { id, heldBy: result.heldBy });
    }
  });

  // Move — AD-3: relay to others only (sender does local prediction)
  socket.on('object:move', ({ id, x, y } = {}) => {
    const lobby = lm.lobbyForSocket(socket.id);
    if (!lobby || !id) return;
    lm.moveObject(lobby, id, x, y);
    // not echoed to sender
    socket.to(lobby.token).emit('object:moved', { id, x: Number(x), y: Number(y) });
  });

  // Release — AD-3: final authoritative position, broadcast to all
  socket.on('object:release', ({ id, x, y } = {}) => {
    const lobby = lm.lobbyForSocket(socket.id);
    if (!lobby || !id) return;
    const obj = lm.releaseObject(lobby, id, socket.id, x, y);
    if (!obj) return;
    io.to(lobby.token).emit('object:released', { id, x: obj.x, y: obj.y });
  });

  socket.on('object:remove', ({ id } = {}) => {
    const lobby = lm.lobbyForSocket(socket.id);
    if (!lobby || !id) return;
    const removed = lm.removeObject(lobby, id);
    if (removed) io.to(lobby.token).emit('object:removed', { id });
  });

  socket.on('table:clear', () => {
    const lobby = lm.lobbyForSocket(socket.id);
    if (!lobby) return;
    lm.clearTable(lobby);
    io.to(lobby.token).emit('table:cleared', {});
  });
});

// --- Start ---------------------------------------------------------------

server.listen(PORT, () => {
  console.log(`Topper backend listening on http://localhost:${PORT}`);
});
