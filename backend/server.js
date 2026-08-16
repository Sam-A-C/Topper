'use strict';

require('dotenv').config();

const express      = require('express');
const http         = require('http');
const { Server }   = require('socket.io');
const cors         = require('cors');
const cookieParser = require('cookie-parser');
const path         = require('path');

const bm   = require('./lobbyManager');
const db   = require('./db');
const auth = require('./auth');

const PORT        = process.env.PORT        || 3000;
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

// --- Express -------------------------------------------------------------

const app = express();
app.use(cors({ origin: CORS_ORIGIN, credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use(auth.attachUser);

auth.routes(app);

// Ops health check. Persistence is fire-and-forget by design, so without
// this a broken schema would fail silently — every insert erroring into the
// log while the app looked fine. Counts only; no user data.
app.get('/api/health', async (_req, res) => {
  const out = { ok: true, db: { configured: db.enabled } };
  if (db.enabled) {
    try {
      const { rows } = await db.query(`
        SELECT (SELECT count(*) FROM battles)       AS battles,
               (SELECT count(*) FROM battle_events) AS events,
               (SELECT count(*) FROM battle_units)  AS units,
               (SELECT count(*) FROM unit_catalog)  AS catalog,
               (SELECT count(*) FROM users)         AS users`);
      out.db.connected = true;
      out.db.counts = Object.fromEntries(
        Object.entries(rows[0]).map(([k, v]) => [k, Number(v)]));
    } catch (err) {
      out.ok = false;
      out.db.connected = false;
      out.db.error = err.message;
    }
  }
  res.status(out.ok ? 200 : 503).json(out);
});

app.use(express.static(path.join(__dirname, '..')));

const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: CORS_ORIGIN, methods: ['GET', 'POST'], credentials: true },
});

// --- Persistence helpers -------------------------------------------------
//
// Every write is fire-and-forget: a database hiccup must never break a live
// recording session. The in-memory battle stays authoritative for the
// session; the DB is durable storage that trails it.

function persist(label, promise) {
  if (!db.enabled) return;
  Promise.resolve(promise).catch(err =>
    console.error(`[persist:${label}]`, err.message));
}

// Attaches a DB row to a battle the first time it needs one.
async function ensureRow(battle, userId) {
  if (!db.enabled) return null;
  if (!battle.dbId) {
    battle.dbId = await db.createBattleRow(battle, userId);
  } else if (userId && !battle.ownerId) {
    await db.claimBattle(battle.dbId, userId);
    battle.ownerId = userId;
  }
  return battle.dbId;
}

io.on('connection', (socket) => {
  const user = auth.userFromHandshake(socket);
  socket.data.userId = user?.uid ?? null;

  socket.emit('auth:state', user
    ? { signedIn: true, email: user.email, name: user.name, picture: user.picture }
    : { signedIn: false, ...auth.status() });

  // -----------------------------------------------------------------------
  // Battle lifecycle
  // -----------------------------------------------------------------------

  socket.on('battle:start', async () => {
    const battle = bm.createBattle();
    battle.ownerId = socket.data.userId;
    bm.addPlayer(battle, socket.id);
    socket.join(battle.token);
    socket.emit('battle:state', {
      ...bm.battleSnapshot(battle, socket.id),
      persisted: !!socket.data.userId && db.enabled,
    });
    persist('createBattle', ensureRow(battle, socket.data.userId));
  });

  socket.on('battle:join', async ({ token } = {}) => {
    if (!token) return socket.emit('battle:error', { message: 'Token required.' });
    const code = String(token).toUpperCase();

    let battle = bm.getBattle(code);

    // Not in memory — try to rehydrate it from the database.
    if (!battle && db.enabled) {
      try {
        const stored = await db.loadBattle(code);
        if (stored) battle = bm.adoptBattle(stored);
      } catch (err) {
        console.error('[loadBattle]', err.message);
      }
    }

    if (!battle) return socket.emit('battle:error', { message: 'Battle not found.' });

    const player = bm.addPlayer(battle, socket.id);
    socket.join(battle.token);
    socket.emit('battle:state', {
      ...bm.battleSnapshot(battle, socket.id),
      persisted: !!battle.ownerId && db.enabled,
    });
    socket.to(battle.token).emit('lobby:playerJoined', {
      socketId: socket.id, username: player.username, color: player.color,
    });
    persist('claim', ensureRow(battle, socket.data.userId));
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
  // Metadata
  // -----------------------------------------------------------------------

  socket.on('meta:set', (patch = {}) => {
    const battle = bm.battleForSocket(socket.id);
    if (!battle) return;
    const meta = bm.setMeta(battle, patch);
    io.to(battle.token).emit('meta:updated', meta);
    persist('meta', (async () => {
      const id = await ensureRow(battle, socket.data.userId);
      if (id) await db.updateBattleMeta(id, meta);
    })());
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
    persist('unit', (async () => {
      const id = await ensureRow(battle, socket.data.userId);
      if (id) await db.insertUnit(id, unit, battle.meta.sides[unit.side]?.faction);
    })());
  });

  socket.on('unit:remove', ({ id } = {}) => {
    const battle = bm.battleForSocket(socket.id);
    if (!battle || !id) return;
    if (!bm.removeUnit(battle, id)) return;
    io.to(battle.token).emit('unit:removed', { id });
    persist('unitRemove', db.deleteUnit(id));
  });

  // -----------------------------------------------------------------------
  // The log (AD-7). battle_events is this same sequence, made durable.
  // -----------------------------------------------------------------------

  socket.on('log:append', (raw = {}) => {
    const battle = bm.battleForSocket(socket.id);
    if (!battle) return;
    const ev = bm.appendEvent(battle, raw);
    if (!ev) return;
    io.to(battle.token).emit('log:appended', ev);
    persist('event', (async () => {
      const id = await ensureRow(battle, socket.data.userId);
      if (id) await db.insertEvent(id, ev);
    })());
  });

  socket.on('log:undo', () => {
    const battle = bm.battleForSocket(socket.id);
    if (!battle) return;
    const seq = bm.undoLast(battle);
    if (seq === null) return;
    io.to(battle.token).emit('log:undone', { seq });
    if (battle.dbId) persist('undo', db.deleteEventBySeq(battle.dbId, seq));
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
    io.to(battle.token).emit('battle:cursorSet', bm.stepCursor(battle, dir > 0 ? 1 : -1));
  });

  // -----------------------------------------------------------------------
  // Drag (movement phase) — preview only; the `move` event is authoritative.
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

// Only evicts battles from MEMORY. Anything with an owner is already durable
// in the database and can be rejoined by token at any time.
setInterval(() => bm.sweepEmptyBattles(), 60 * 60 * 1000).unref?.();

// --- Start ---------------------------------------------------------------

db.init()
  .catch(err => console.error('[db.init]', err.message))
  .finally(() => {
    const a = auth.status();
    if (!a.enabled) {
      console.log(`Sign-in disabled (missing: ${a.missing.join(', ')}).`);
    }
    server.listen(PORT, () => {
      console.log(`Topper battle recorder listening on http://localhost:${PORT}`);
    });
  });
