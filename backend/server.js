'use strict';

require('dotenv').config();

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const cors       = require('cors');
const path       = require('path');

const bm = require('./lobbyManager');

const PORT        = process.env.PORT        || 3000;
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

// --- Express -------------------------------------------------------------

const app = express();
app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.static(path.join(__dirname, '..')));

const server = http.createServer(app);

// --- Socket.io -----------------------------------------------------------

const io = new Server(server, {
  cors: { origin: CORS_ORIGIN, methods: ['GET', 'POST'] },
});

io.on('connection', (socket) => {
  // -----------------------------------------------------------------------
  // Battle lifecycle
  // -----------------------------------------------------------------------

  socket.on('battle:start', () => {
    const battle = bm.createBattle();
    bm.addPlayer(battle, socket.id);
    socket.join(battle.token);
    socket.emit('battle:state', bm.battleSnapshot(battle, socket.id));
  });

  socket.on('battle:join', ({ token } = {}) => {
    if (!token) return socket.emit('battle:error', { message: 'Token required.' });
    const battle = bm.getBattle(String(token).toUpperCase());
    if (!battle) return socket.emit('battle:error', { message: 'Battle not found.' });
    const player = bm.addPlayer(battle, socket.id);
    socket.join(battle.token);
    socket.emit('battle:state', bm.battleSnapshot(battle, socket.id));
    socket.to(battle.token).emit('lobby:playerJoined', {
      socketId: socket.id,
      username: player.username,
      color:    player.color,
    });
  });

  socket.on('disconnect', () => {
    const battle = bm.removePlayer(socket.id);
    if (battle) io.to(battle.token).emit('lobby:playerLeft', { socketId: socket.id });
  });

  socket.on('player:rename', ({ username } = {}) => {
    if (typeof username !== 'string') return;
    const trimmed = username.trim().slice(0, 32);
    if (!trimmed) return;
    if (!bm.renamePlayer(socket.id, trimmed)) return;
    const battle = bm.battleForSocket(socket.id);
    io.to(battle.token).emit('player:renamed', { socketId: socket.id, username: trimmed });
  });

  // -----------------------------------------------------------------------
  // Battle metadata
  // -----------------------------------------------------------------------

  socket.on('meta:set', (patch = {}) => {
    const battle = bm.battleForSocket(socket.id);
    if (!battle) return;
    const meta = bm.setMeta(battle, patch);
    io.to(battle.token).emit('meta:updated', meta);
  });

  // -----------------------------------------------------------------------
  // Roster
  // -----------------------------------------------------------------------

  socket.on('unit:add', (def = {}) => {
    const battle = bm.battleForSocket(socket.id);
    if (!battle) return;
    let unit;
    try { unit = bm.addUnit(battle, def); }
    catch { return; }
    io.to(battle.token).emit('unit:added', unit);
  });

  socket.on('unit:remove', ({ id } = {}) => {
    const battle = bm.battleForSocket(socket.id);
    if (!battle || !id) return;
    if (bm.removeUnit(battle, id)) io.to(battle.token).emit('unit:removed', { id });
  });

  // -----------------------------------------------------------------------
  // The log (AD-7) — single write path for all board state
  // -----------------------------------------------------------------------

  socket.on('log:append', (raw = {}) => {
    const battle = bm.battleForSocket(socket.id);
    if (!battle) return;
    const ev = bm.appendEvent(battle, raw);
    if (ev) io.to(battle.token).emit('log:appended', ev);
  });

  socket.on('log:undo', () => {
    const battle = bm.battleForSocket(socket.id);
    if (!battle) return;
    const seq = bm.undoLast(battle);
    if (seq !== null) io.to(battle.token).emit('log:undone', { seq });
  });

  // -----------------------------------------------------------------------
  // Cursor
  // -----------------------------------------------------------------------

  socket.on('battle:setCursor', (cursor = {}) => {
    const battle = bm.battleForSocket(socket.id);
    if (!battle) return;
    io.to(battle.token).emit('battle:cursorSet', bm.setCursor(battle, cursor));
  });

  socket.on('battle:stepCursor', ({ dir } = {}) => {
    const battle = bm.battleForSocket(socket.id);
    if (!battle) return;
    const next = bm.stepCursor(battle, dir > 0 ? 1 : -1);
    io.to(battle.token).emit('battle:cursorSet', next);
  });

  // -----------------------------------------------------------------------
  // Drag (movement phase) — position preview only. The authoritative
  // position change is the `move` event the client appends on release.
  // -----------------------------------------------------------------------

  socket.on('unit:grab', ({ id } = {}) => {
    const battle = bm.battleForSocket(socket.id);
    if (!battle || !id) return;
    const result = bm.grabUnit(battle, id, socket.id);
    if (result.granted) {
      socket.emit('unit:grabGranted', { id });
      io.to(battle.token).emit('unit:grabbed', { id, socketId: socket.id });
    } else {
      socket.emit('unit:grabDenied', { id, heldBy: result.heldBy });
    }
  });

  socket.on('unit:drag', ({ id, x, y } = {}) => {
    const battle = bm.battleForSocket(socket.id);
    if (!battle || !id) return;
    socket.to(battle.token).emit('unit:dragged', { id, x: +x, y: +y });
  });

  socket.on('unit:release', ({ id } = {}) => {
    const battle = bm.battleForSocket(socket.id);
    if (!battle || !id) return;
    bm.releaseUnit(battle, id);
    io.to(battle.token).emit('unit:released', { id });
  });
});

// --- Housekeeping --------------------------------------------------------

// Reclaim battles nobody has returned to. Runs hourly; the TTL itself lives
// in lobbyManager.
setInterval(() => bm.sweepEmptyBattles(), 60 * 60 * 1000).unref?.();

// --- Start ---------------------------------------------------------------

server.listen(PORT, () => {
  console.log(`Topper battle recorder listening on http://localhost:${PORT}`);
});
