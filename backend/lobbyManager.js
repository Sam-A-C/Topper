'use strict';

const { v4: uuidv4 } = require('uuid');

// --- constants -----------------------------------------------------------

const TOKEN_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I ambiguity
const TOKEN_LEN = 6;

const PLAYER_COLORS = [
  '#e94560', '#4fc3f7', '#81c784', '#ffb74d',
  '#ce93d8', '#80cbc4', '#f48fb1', '#fff176',
];

// Per AD-4: base fields + per-type defaults
const OBJECT_DEFAULTS = {
  token: { width: 1.26, height: 1.26, color: '#e94560' },  // 32mm base
  card:  { width: 2.5,  height: 3.5,  color: '#4fc3f7', faceUp: true },
  tile:  { width: 3.0,  height: 3.0,  color: '#81c784' },
};

// --- internal helpers ----------------------------------------------------

function mintToken() {
  let t = '';
  for (let i = 0; i < TOKEN_LEN; i++) {
    t += TOKEN_CHARS[Math.floor(Math.random() * TOKEN_CHARS.length)];
  }
  return t;
}

function pickColor(usedColors) {
  for (const c of PLAYER_COLORS) {
    if (!usedColors.has(c)) return c;
  }
  // fallback: random hex when palette exhausted
  return '#' + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0');
}

function generateUsername(players) {
  const used = new Set([...players.values()].map(p => p.username));
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  for (let i = 0; i < 200; i++) {
    const name = 'Player-' + letters[Math.floor(Math.random() * letters.length)]
                           + Math.floor(Math.random() * 10);
    if (!used.has(name)) return name;
  }
  return 'Player-' + uuidv4().slice(0, 4).toUpperCase();
}

// --- lobbies store -------------------------------------------------------

// Map<token, Lobby>
// Lobby = { token, players: Map<socketId, {username, color}>, objects: Map<id, Object>, locks: Map<objectId, socketId> }
const lobbies = new Map();

// reverse index: socketId → token (a socket can be in at most one lobby)
const socketLobby = new Map();

// --- public API ----------------------------------------------------------

function createLobby() {
  let token;
  do { token = mintToken(); } while (lobbies.has(token));
  const lobby = {
    token,
    players: new Map(),
    objects: new Map(),
    locks:   new Map(),
  };
  lobbies.set(token, lobby);
  return lobby;
}

function getLobby(token) {
  return lobbies.get(token) ?? null;
}

function addPlayer(lobby, socketId) {
  const usedColors = new Set([...lobby.players.values()].map(p => p.color));
  const color    = pickColor(usedColors);
  const username = generateUsername(lobby.players);
  const player   = { username, color };
  lobby.players.set(socketId, player);
  socketLobby.set(socketId, lobby.token);
  return player;
}

// Returns the lobby the socket was in (or null), after removing them.
function removePlayer(socketId) {
  const token = socketLobby.get(socketId);
  if (!token) return null;
  socketLobby.delete(socketId);
  const lobby = lobbies.get(token);
  if (!lobby) return null;
  lobby.players.delete(socketId);
  // release any locks held by this socket
  for (const [objId, holder] of lobby.locks) {
    if (holder === socketId) lobby.locks.delete(objId);
  }
  // destroy lobby when last player leaves
  if (lobby.players.size === 0) lobbies.delete(token);
  return lobby;
}

function renamePlayer(socketId, username) {
  const token = socketLobby.get(socketId);
  if (!token) return false;
  const lobby = lobbies.get(token);
  if (!lobby) return false;
  const player = lobby.players.get(socketId);
  if (!player) return false;
  player.username = username;
  return true;
}

function lobbyForSocket(socketId) {
  const token = socketLobby.get(socketId);
  return token ? lobbies.get(token) ?? null : null;
}

// --- object management ---------------------------------------------------

function maxZ(lobby) {
  let z = 0;
  for (const obj of lobby.objects.values()) {
    if (obj.z > z) z = obj.z;
  }
  return z;
}

function addObject(lobby, { type, x, y, label }) {
  const defaults = OBJECT_DEFAULTS[type];
  if (!defaults) throw new Error(`Unknown object type: ${type}`);
  const id = uuidv4();
  const z  = maxZ(lobby) + 1;
  const obj = {
    id,
    type,
    x: Number(x),
    y: Number(y),
    z,
    width:  defaults.width,
    height: defaults.height,
    color:  defaults.color,
    label:  label ?? '',
    ...(type === 'card' ? { faceUp: defaults.faceUp } : {}),
  };
  lobby.objects.set(id, obj);
  return obj;
}

// Returns { granted, z, heldBy } — z only set when granted.
function grabObject(lobby, objectId, socketId) {
  if (!lobby.objects.has(objectId)) return { granted: false, heldBy: null };
  const holder = lobby.locks.get(objectId);
  if (holder && holder !== socketId) return { granted: false, heldBy: holder };
  const z = maxZ(lobby) + 1;
  lobby.locks.set(objectId, socketId);
  const obj = lobby.objects.get(objectId);
  obj.z = z;
  return { granted: true, z };
}

function moveObject(lobby, objectId, x, y) {
  const obj = lobby.objects.get(objectId);
  if (!obj) return false;
  obj.x = Number(x);
  obj.y = Number(y);
  return true;
}

// Returns the released object (with authoritative final position), or null.
function releaseObject(lobby, objectId, socketId, x, y) {
  if (!lobby.locks.get(objectId) === socketId) {
    // even if lock mismatch, still update position (last-write-wins is fine here)
  }
  lobby.locks.delete(objectId);
  const obj = lobby.objects.get(objectId);
  if (!obj) return null;
  obj.x = Number(x);
  obj.y = Number(y);
  return obj;
}

function removeObject(lobby, objectId) {
  lobby.locks.delete(objectId);
  return lobby.objects.delete(objectId);
}

function clearTable(lobby) {
  lobby.objects.clear();
  lobby.locks.clear();
}

// Snapshot for lobby:state
function lobbySnapshot(lobby, socketId) {
  return {
    token:   lobby.token,
    yourId:  socketId,
    players: [...lobby.players.entries()].map(([id, p]) => ({ socketId: id, ...p })),
    objects: [...lobby.objects.values()],
  };
}

module.exports = {
  createLobby,
  getLobby,
  addPlayer,
  removePlayer,
  renamePlayer,
  lobbyForSocket,
  addObject,
  grabObject,
  moveObject,
  releaseObject,
  removeObject,
  clearTable,
  lobbySnapshot,
};
