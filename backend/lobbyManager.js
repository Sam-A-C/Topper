'use strict';

const { v4: uuidv4 } = require('uuid');

// --- constants -----------------------------------------------------------

const TOKEN_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I ambiguity
const TOKEN_LEN = 6;

const PLAYER_COLORS = [
  '#e94560', '#4fc3f7', '#81c784', '#ffb74d',
  '#ce93d8', '#80cbc4', '#f48fb1', '#fff176',
];

// The two armies. Distinct from player colors: a player is a person in the
// lobby, a side is an army on the board.
const SIDE_COLORS = { A: '#e94560', B: '#4fc3f7' };

const PHASES = ['command', 'movement', 'shooting', 'charge', 'fight'];
const SIDES  = ['A', 'B'];

// Per-kind defaults (AD-4 pattern: base + per-kind extension)
const UNIT_DEFAULTS = {
  unit:      { size: 2.0, startingStrength: 10 },
  terrain:   { size: 6.0, startingStrength: 0  },
  objective: { size: 1.6, startingStrength: 0  },
};

// Effect scale (AD-7) — the whole "roughly how effective" mechanic.
const EFFECTS = ['whiff', 'light', 'moderate', 'heavy', 'wiped'];

const EVENT_TYPES = new Set([
  'deploy', 'move', 'shoot', 'charge', 'fight',
  'battleshock', 'score', 'cp', 'destroy', 'note',
]);

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

// --- battles store -------------------------------------------------------

// Map<token, Battle>
const battles = new Map();

// reverse index: socketId → token (a socket is in at most one battle)
const socketBattle = new Map();

// --- battle lifecycle ----------------------------------------------------

function createBattle() {
  let token;
  do { token = mintToken(); } while (battles.has(token));
  const battle = {
    token,
    players: new Map(),      // socketId → { username, color }
    meta: {
      name: '',
      date: new Date().toISOString().slice(0, 10),
      mission: '',
      sides: {
        A: { name: 'Player A', faction: '' },
        B: { name: 'Player B', faction: '' },
      },
    },
    roster: new Map(),       // unitId → UnitDef (static)
    log:    [],              // [Event] — append-only, the source of truth (AD-7)
    cursor: { round: 1, side: 'A', phase: 'command' },
    locks:  new Map(),       // unitId → socketId (drag locking)
    nextSeq: 1,
  };
  battles.set(token, battle);
  return battle;
}

function getBattle(token) {
  return battles.get(token) ?? null;
}

// Rehydrates a battle loaded from storage back into the live in-memory shape.
// `nextSeq` continues past the highest stored seq so the log stays strictly
// ordered across sessions (AD-7).
function adoptBattle(stored) {
  const existing = battles.get(stored.token);
  if (existing) return existing;

  const log = stored.log ?? [];
  const battle = {
    token:   stored.token,
    dbId:    stored.dbId,
    ownerId: stored.ownerId,
    players: new Map(),
    meta:    stored.meta,
    roster:  new Map(stored.roster.map(u => [u.id, u])),
    log,
    cursor:  deriveCursor(log),
    locks:   new Map(),
    nextSeq: log.reduce((m, e) => Math.max(m, e.seq), 0) + 1,
  };
  battles.set(battle.token, battle);
  return battle;
}

// Resume where the recording left off rather than at round 1.
function deriveCursor(log) {
  const last = log[log.length - 1];
  return last
    ? { round: last.round, side: last.side, phase: last.phase }
    : { round: 1, side: 'A', phase: 'command' };
}

function battleForSocket(socketId) {
  const token = socketBattle.get(socketId);
  return token ? battles.get(token) ?? null : null;
}

function addPlayer(battle, socketId) {
  delete battle.emptyAt;   // rejoined — cancel the reclaim timer
  const usedColors = new Set([...battle.players.values()].map(p => p.color));
  const player = {
    username: generateUsername(battle.players),
    color:    pickColor(usedColors),
  };
  battle.players.set(socketId, player);
  socketBattle.set(socketId, battle.token);
  return player;
}

function removePlayer(socketId) {
  const token = socketBattle.get(socketId);
  if (!token) return null;
  socketBattle.delete(socketId);
  const battle = battles.get(token);
  if (!battle) return null;
  battle.players.delete(socketId);
  for (const [unitId, holder] of battle.locks) {
    if (holder === socketId) battle.locks.delete(unitId);
  }
  // An empty battle is NOT destroyed straight away. The log is the whole
  // deliverable here, so a dropped connection or a page reload must not
  // take the record with it — it is reclaimed only after EMPTY_TTL_MS.
  if (battle.players.size === 0) battle.emptyAt = Date.now();
  return battle;
}

const EMPTY_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours — long enough to survive a whole game night

function sweepEmptyBattles(now = Date.now()) {
  let swept = 0;
  for (const [token, battle] of battles) {
    if (battle.players.size === 0 && battle.emptyAt && now - battle.emptyAt > EMPTY_TTL_MS) {
      battles.delete(token);
      swept++;
    }
  }
  return swept;
}

function renamePlayer(socketId, username) {
  const battle = battleForSocket(socketId);
  if (!battle) return false;
  const player = battle.players.get(socketId);
  if (!player) return false;
  player.username = username;
  return true;
}

// --- meta ----------------------------------------------------------------

function setMeta(battle, patch = {}) {
  const { name, date, mission, sides } = patch;
  if (typeof name    === 'string') battle.meta.name    = name.slice(0, 80);
  if (typeof date    === 'string') battle.meta.date    = date.slice(0, 32);
  if (typeof mission === 'string') battle.meta.mission = mission.slice(0, 80);
  if (sides && typeof sides === 'object') {
    for (const s of SIDES) {
      if (!sides[s]) continue;
      if (typeof sides[s].name === 'string') {
        battle.meta.sides[s].name = sides[s].name.slice(0, 40);
      }
      if (typeof sides[s].faction === 'string') {
        battle.meta.sides[s].faction = sides[s].faction.slice(0, 40);
      }
    }
  }
  return battle.meta;
}

// --- roster --------------------------------------------------------------

function addUnit(battle, { name, catalogName, points, side, kind = 'unit',
                          startingStrength, size } = {}) {
  const defaults = UNIT_DEFAULTS[kind];
  if (!defaults) throw new Error(`Unknown unit kind: ${kind}`);

  // terrain and objectives belong to no side
  const resolvedSide = kind === 'unit' ? (SIDES.includes(side) ? side : 'A') : null;
  const display = (name ?? '').toString().trim().slice(0, 40) || defaultName(kind);

  const unit = {
    id:    uuidv4(),
    name:  display,
    // The datasheet name, kept separate so board labels like "Genestealers 2"
    // or a nickname still group with their datasheet in cross-battle stats.
    catalogName: (catalogName ?? '').toString().trim().slice(0, 60) || display,
    points: Number.isFinite(+points) ? Math.max(0, Math.floor(+points)) : 0,
    attachedTo: null,      // set via attachUnit once both ids exist
    side:  resolvedSide,
    kind,
    startingStrength: Number.isFinite(+startingStrength)
      ? Math.max(0, Math.floor(+startingStrength))
      : defaults.startingStrength,
    size:  Number.isFinite(+size) ? Math.max(0.3, +size) : defaults.size,
    color: resolvedSide ? SIDE_COLORS[resolvedSide]
         : kind === 'objective' ? '#ffb74d'
         : '#5a6b8c',
  };
  battle.roster.set(unit.id, unit);
  return unit;
}

function defaultName(kind) {
  return kind === 'terrain' ? 'Ruins'
       : kind === 'objective' ? 'Objective'
       : 'Unit';
}

function removeUnit(battle, unitId) {
  battle.locks.delete(unitId);
  // anything led by this unit is orphaned, not silently pointing at nothing
  for (const u of battle.roster.values()) {
    if (u.attachedTo === unitId) u.attachedTo = null;
  }
  return battle.roster.delete(unitId);
}

// Leader joins a bodyguard unit (40k "Leader"). Pass bodyId = null to detach.
// Returns the updated leader, or null when the pairing is not allowed.
function attachUnit(battle, leaderId, bodyId) {
  const leader = battle.roster.get(leaderId);
  if (!leader || leader.kind !== 'unit') return null;

  if (bodyId == null) { leader.attachedTo = null; return leader; }

  const body = battle.roster.get(bodyId);
  if (!body || body.kind !== 'unit') return null;
  if (body.id === leader.id) return null;
  if (body.side !== leader.side) return null;
  // a bodyguard cannot itself be attached, which would make a chain
  if (body.attachedTo) return null;
  // nor can a unit that is already leading others become a follower
  for (const u of battle.roster.values()) {
    if (u.attachedTo === leader.id) return null;
  }
  leader.attachedTo = bodyId;
  return leader;
}

// --- log (AD-7) ----------------------------------------------------------

// Server stamps id/seq/cursor so ordering is authoritative and clients
// cannot disagree about when something happened.
function appendEvent(battle, raw = {}) {
  if (!EVENT_TYPES.has(raw.type)) return null;

  const ev = {
    id:    uuidv4(),
    seq:   battle.nextSeq++,
    ts:    Date.now(),
    round: battle.cursor.round,
    side:  battle.cursor.side,
    phase: battle.cursor.phase,
    type:  raw.type,
  };

  switch (raw.type) {
    case 'deploy':
      if (!battle.roster.has(raw.unitId)) return null;
      Object.assign(ev, { unitId: raw.unitId, x: +raw.x, y: +raw.y });
      break;

    case 'move':
      if (!battle.roster.has(raw.unitId)) return null;
      Object.assign(ev, {
        unitId:   raw.unitId,
        from:     raw.from ? { x: +raw.from.x, y: +raw.from.y } : null,
        to:       { x: +raw.to.x, y: +raw.to.y },
        moveType: ['stationary','normal','advance','fallback','reserves','reposition']
                  .includes(raw.moveType) ? raw.moveType : 'normal',
      });
      break;

    case 'shoot':
    case 'fight':
      if (!battle.roster.has(raw.targetId)) return null;
      Object.assign(ev, {
        [raw.type === 'shoot' ? 'shooterId' : 'attackerId']:
          raw.shooterId ?? raw.attackerId,
        targetId: raw.targetId,
        effect:   EFFECTS.includes(raw.effect) ? raw.effect : 'light',
      });
      break;

    case 'charge':
      Object.assign(ev, {
        chargerId: raw.chargerId,
        targetId:  raw.targetId,
        success:   !!raw.success,
      });
      break;

    case 'battleshock':
      if (!battle.roster.has(raw.unitId)) return null;
      Object.assign(ev, { unitId: raw.unitId, passed: !!raw.passed });
      break;

    case 'score':
      Object.assign(ev, {
        side:  SIDES.includes(raw.side) ? raw.side : battle.cursor.side,
        vp:    Math.max(0, Math.floor(+raw.vp || 0)),
        kind:  raw.kind === 'secondary' ? 'secondary' : 'primary',
        label: (raw.label ?? '').toString().slice(0, 60),
      });
      break;

    case 'cp':
      Object.assign(ev, {
        side:   SIDES.includes(raw.side) ? raw.side : battle.cursor.side,
        delta:  Math.trunc(+raw.delta || 0),
        reason: (raw.reason ?? '').toString().slice(0, 60),
      });
      break;

    case 'destroy':
      if (!battle.roster.has(raw.unitId)) return null;
      Object.assign(ev, { unitId: raw.unitId });
      break;

    case 'note':
      Object.assign(ev, { text: (raw.text ?? '').toString().slice(0, 280) });
      break;
  }

  battle.log.push(ev);
  return ev;
}

// Pops the most recent event. Returns its seq, or null if the log is empty.
function undoLast(battle) {
  const ev = battle.log.pop();
  return ev ? ev.seq : null;
}

// --- cursor --------------------------------------------------------------

function setCursor(battle, { round, side, phase } = {}) {
  const r = Math.max(1, Math.floor(+round || 1));
  battle.cursor = {
    round: r,
    side:  SIDES.includes(side)   ? side  : 'A',
    phase: PHASES.includes(phase) ? phase : 'command',
  };
  return battle.cursor;
}

// Step the cursor forward/back through the 5x2x5 state machine.
function stepCursor(battle, dir) {
  const { round, side, phase } = battle.cursor;
  let pi = PHASES.indexOf(phase);
  let si = SIDES.indexOf(side);
  let r  = round;

  if (dir > 0) {
    pi++;
    if (pi >= PHASES.length) { pi = 0; si++; }
    if (si >= SIDES.length)  { si = 0; r++; }
  } else {
    pi--;
    if (pi < 0) { pi = PHASES.length - 1; si--; }
    if (si < 0) { si = SIDES.length - 1; r--; }
    if (r < 1) return battle.cursor; // clamp at the very start
  }

  battle.cursor = { round: r, side: SIDES[si], phase: PHASES[pi] };
  return battle.cursor;
}

// --- drag locking (movement phase only) ----------------------------------

function grabUnit(battle, unitId, socketId) {
  if (!battle.roster.has(unitId)) return { granted: false, heldBy: null };
  const holder = battle.locks.get(unitId);
  if (holder && holder !== socketId) return { granted: false, heldBy: holder };
  battle.locks.set(unitId, socketId);
  return { granted: true };
}

function releaseUnit(battle, unitId) {
  battle.locks.delete(unitId);
}

// --- snapshot ------------------------------------------------------------

function battleSnapshot(battle, socketId) {
  return {
    token:   battle.token,
    yourId:  socketId,
    meta:    battle.meta,
    players: [...battle.players.entries()].map(([id, p]) => ({ socketId: id, ...p })),
    roster:  [...battle.roster.values()],
    log:     battle.log,
    cursor:  battle.cursor,
  };
}

module.exports = {
  PHASES, SIDES, EFFECTS, SIDE_COLORS,
  createBattle, getBattle, adoptBattle, battleForSocket, sweepEmptyBattles,
  addPlayer, removePlayer, renamePlayer,
  setMeta,
  addUnit, removeUnit, attachUnit,
  appendEvent, undoLast,
  setCursor, stepCursor,
  grabUnit, releaseUnit,
  battleSnapshot,
};
