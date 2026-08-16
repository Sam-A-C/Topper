'use strict';

const { Pool } = require('pg');

// ─────────────────────────────────────────────────────────────────────────
// Persistence.
//
// AD-7 is unchanged by adding a database: `battle_events` IS the log. The DB
// is durable storage for the same append-only sequence, not a second source
// of truth. Nothing here derives board state — that stays in battle.js.
//
// The schema is shaped for CROSS-BATTLE ANALYTICS, which drives two choices
// a naive design would get wrong:
//   1. Events are rows with typed columns, not a JSON blob, so aggregate
//      queries run in SQL rather than by loading every battle into memory.
//   2. Units resolve to a shared `unit_catalog` entry, so "Intercessors" in
//      one battle and "intercessors " in another group together. Without
//      this, every cross-game query aggregates on free text.
//
// If DATABASE_URL is unset the whole module no-ops and the app runs purely
// in memory, so local dev needs no infrastructure.
// ─────────────────────────────────────────────────────────────────────────

const enabled = !!process.env.DATABASE_URL;

// Managed providers (Render, Neon, Supabase) require TLS and present certs
// that will not chain locally; a local Postgres usually offers no TLS at all
// and errors if asked. Detect rather than make the operator configure it.
function sslSetting() {
  if (process.env.PGSSL === 'disable') return false;
  if (process.env.PGSSL === 'require')  return { rejectUnauthorized: false };
  const url = process.env.DATABASE_URL || '';
  const isLocal = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url);
  return isLocal ? false : { rejectUnauthorized: false };
}

const pool = enabled
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: sslSetting(),
      max: 8,
    })
  : null;

async function query(text, params) {
  if (!enabled) return { rows: [], rowCount: 0 };
  return pool.query(text, params);
}

// --- schema --------------------------------------------------------------

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id          BIGSERIAL PRIMARY KEY,
  google_sub  TEXT UNIQUE NOT NULL,
  email       TEXT NOT NULL,
  name        TEXT,
  picture     TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Cross-battle unit identity. This is what makes "across all games" work.
CREATE TABLE IF NOT EXISTS unit_catalog (
  id           BIGSERIAL PRIMARY KEY,
  norm_name    TEXT UNIQUE NOT NULL,   -- lowercased, punctuation stripped
  display_name TEXT NOT NULL,
  faction      TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS battles (
  id           BIGSERIAL PRIMARY KEY,
  token        TEXT UNIQUE NOT NULL,
  owner_id     BIGINT REFERENCES users(id) ON DELETE SET NULL,
  name         TEXT NOT NULL DEFAULT '',
  mission      TEXT NOT NULL DEFAULT '',
  fought_on    DATE,
  side_a_name  TEXT NOT NULL DEFAULT 'Player A',
  side_b_name  TEXT NOT NULL DEFAULT 'Player B',
  side_a_faction TEXT,
  side_b_faction TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS battles_owner_idx ON battles(owner_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS battle_units (
  id                TEXT PRIMARY KEY,          -- the uuid used in the log
  battle_id         BIGINT NOT NULL REFERENCES battles(id) ON DELETE CASCADE,
  catalog_id        BIGINT REFERENCES unit_catalog(id) ON DELETE SET NULL,
  name              TEXT NOT NULL,
  side              TEXT,                      -- 'A' | 'B' | NULL for terrain/objectives
  kind              TEXT NOT NULL,
  starting_strength INTEGER NOT NULL DEFAULT 0,
  size              REAL NOT NULL DEFAULT 2,
  color             TEXT,
  points            INTEGER NOT NULL DEFAULT 0
);
-- Migration for databases created before the points column existed.
-- CREATE TABLE IF NOT EXISTS skips existing tables, so new columns need this.
ALTER TABLE battle_units ADD COLUMN IF NOT EXISTS points INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS battle_units_battle_idx  ON battle_units(battle_id);
CREATE INDEX IF NOT EXISTS battle_units_catalog_idx ON battle_units(catalog_id);

-- The log. Wide and typed so analytics is plain SQL.
CREATE TABLE IF NOT EXISTS battle_events (
  id             BIGSERIAL PRIMARY KEY,
  battle_id      BIGINT NOT NULL REFERENCES battles(id) ON DELETE CASCADE,
  seq            INTEGER NOT NULL,
  event_uuid     TEXT NOT NULL,
  ts             TIMESTAMPTZ NOT NULL DEFAULT now(),
  round          INTEGER NOT NULL,
  side           TEXT NOT NULL,
  phase          TEXT NOT NULL,
  type           TEXT NOT NULL,

  actor_unit_id  TEXT REFERENCES battle_units(id) ON DELETE SET NULL,
  target_unit_id TEXT REFERENCES battle_units(id) ON DELETE SET NULL,

  effect         TEXT,      -- whiff | light | moderate | heavy | wiped
  effect_value   REAL,      -- 0 / .10 / .33 / .66 / 1 — AVG() this directly
  move_type      TEXT,
  from_x REAL, from_y REAL, to_x REAL, to_y REAL,
  distance       REAL,      -- precomputed so movement analytics needs no math
  vp             INTEGER,
  score_kind     TEXT,
  cp_delta       INTEGER,
  passed         BOOLEAN,
  success        BOOLEAN,
  label          TEXT,
  text           TEXT,

  UNIQUE (battle_id, seq)
);
CREATE INDEX IF NOT EXISTS events_battle_idx ON battle_events(battle_id, seq);
CREATE INDEX IF NOT EXISTS events_type_idx   ON battle_events(type);
CREATE INDEX IF NOT EXISTS events_actor_idx  ON battle_events(actor_unit_id);
CREATE INDEX IF NOT EXISTS events_target_idx ON battle_events(target_unit_id);

-- Convenience view: every attack resolved to catalogue names, which is the
-- shape almost every cross-battle question wants.
CREATE OR REPLACE VIEW attack_log AS
SELECT
  e.id, e.battle_id, b.token, b.owner_id,
  e.round, e.side, e.phase, e.type,
  ac.display_name AS actor_name,  au.name AS actor_instance_name,  au.side AS actor_side,
  tc.display_name AS target_name, tu.name AS target_instance_name, tu.side AS target_side,
  e.effect, e.effect_value, e.ts
FROM battle_events e
JOIN battles b       ON b.id  = e.battle_id
LEFT JOIN battle_units au ON au.id = e.actor_unit_id
LEFT JOIN battle_units tu ON tu.id = e.target_unit_id
LEFT JOIN unit_catalog ac ON ac.id = au.catalog_id
LEFT JOIN unit_catalog tc ON tc.id = tu.catalog_id
WHERE e.type IN ('shoot', 'fight');
`;

async function init() {
  if (!enabled) {
    console.log('DATABASE_URL not set — running in memory only (no accounts, no saved battles).');
    return false;
  }
  await pool.query(SCHEMA);
  console.log('Database ready.');
  return true;
}

// --- users ---------------------------------------------------------------

async function upsertUser({ sub, email, name, picture }) {
  const { rows } = await query(`
    INSERT INTO users (google_sub, email, name, picture)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (google_sub) DO UPDATE
      SET email = EXCLUDED.email, name = EXCLUDED.name,
          picture = EXCLUDED.picture, last_seen = now()
    RETURNING id, email, name, picture`, [sub, email, name, picture]);
  return rows[0];
}

// --- catalogue -----------------------------------------------------------

// Normalisation is what lets the same unit match across battles. Kept
// deliberately simple: casefold, strip punctuation, collapse whitespace.
function normName(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function resolveCatalogId(name, faction) {
  const norm = normName(name);
  if (!norm) return null;
  const { rows } = await query(`
    INSERT INTO unit_catalog (norm_name, display_name, faction)
    VALUES ($1, $2, $3)
    ON CONFLICT (norm_name) DO UPDATE SET norm_name = EXCLUDED.norm_name
    RETURNING id`, [norm, String(name).trim(), faction ?? null]);
  return rows[0]?.id ?? null;
}

// --- battles -------------------------------------------------------------

async function createBattleRow(battle, ownerId) {
  const { meta } = battle;
  const { rows } = await query(`
    INSERT INTO battles (token, owner_id, name, mission, fought_on,
                         side_a_name, side_b_name, side_a_faction, side_b_faction)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    ON CONFLICT (token) DO UPDATE SET updated_at = now()
    RETURNING id`,
    [battle.token, ownerId ?? null, meta.name, meta.mission, meta.date || null,
     meta.sides.A.name, meta.sides.B.name, meta.sides.A.faction, meta.sides.B.faction]);
  return rows[0]?.id ?? null;
}

async function updateBattleMeta(battleId, meta) {
  await query(`
    UPDATE battles SET name=$2, mission=$3, fought_on=$4,
      side_a_name=$5, side_b_name=$6, side_a_faction=$7, side_b_faction=$8,
      updated_at = now()
    WHERE id = $1`,
    [battleId, meta.name, meta.mission, meta.date || null,
     meta.sides.A.name, meta.sides.B.name, meta.sides.A.faction, meta.sides.B.faction]);
}

async function claimBattle(battleId, ownerId) {
  await query(
    `UPDATE battles SET owner_id = $2, updated_at = now()
     WHERE id = $1 AND owner_id IS NULL`, [battleId, ownerId]);
}

async function insertUnit(battleId, unit, faction) {
  // Catalogue on the DATASHEET name, never the board label — otherwise
  // "Genestealers 1" and "Genestealers 2" become two different units and
  // every cross-battle aggregate silently splits.
  const catalogId = unit.kind === 'unit'
    ? await resolveCatalogId(unit.catalogName || unit.name, faction) : null;
  await query(`
    INSERT INTO battle_units (id, battle_id, catalog_id, name, side, kind,
                              starting_strength, size, color, points)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    ON CONFLICT (id) DO NOTHING`,
    [unit.id, battleId, catalogId, unit.name, unit.side, unit.kind,
     unit.startingStrength, unit.size, unit.color, unit.points ?? 0]);
}

async function deleteUnit(unitId) {
  await query(`DELETE FROM battle_units WHERE id = $1`, [unitId]);
}

const EFFECT_VALUE = { whiff: 0, light: 0.10, moderate: 0.33, heavy: 0.66, wiped: 1 };

async function insertEvent(battleId, ev) {
  const actorId  = ev.shooterId ?? ev.attackerId ?? ev.chargerId ?? ev.unitId ?? null;
  const targetId = ev.targetId ?? null;
  const dist = (ev.type === 'move' && ev.from && ev.to)
    ? Math.hypot(ev.to.x - ev.from.x, ev.to.y - ev.from.y) : null;

  await query(`
    INSERT INTO battle_events (
      battle_id, seq, event_uuid, round, side, phase, type,
      actor_unit_id, target_unit_id, effect, effect_value, move_type,
      from_x, from_y, to_x, to_y, distance,
      vp, score_kind, cp_delta, passed, success, label, text)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
    ON CONFLICT (battle_id, seq) DO NOTHING`,
    [battleId, ev.seq, ev.id, ev.round, ev.side, ev.phase, ev.type,
     actorId, targetId,
     ev.effect ?? null, ev.effect != null ? EFFECT_VALUE[ev.effect] ?? null : null,
     ev.moveType ?? null,
     ev.from?.x ?? ev.x ?? null, ev.from?.y ?? ev.y ?? null,
     ev.to?.x ?? null, ev.to?.y ?? null, dist,
     ev.vp ?? null, ev.kind ?? null, ev.delta ?? null,
     ev.passed ?? null, ev.success ?? null,
     ev.label ?? ev.reason ?? null, ev.text ?? null]);

  await query(`UPDATE battles SET updated_at = now() WHERE id = $1`, [battleId]);
}

async function deleteEventBySeq(battleId, seq) {
  await query(`DELETE FROM battle_events WHERE battle_id = $1 AND seq = $2`, [battleId, seq]);
}

// --- loading -------------------------------------------------------------

async function listBattles(ownerId, limit = 40) {
  const { rows } = await query(`
    SELECT b.token, b.name, b.mission, b.fought_on,
           b.side_a_name, b.side_b_name, b.updated_at,
           (SELECT count(*) FROM battle_events e WHERE e.battle_id = b.id) AS event_count
    FROM battles b
    WHERE b.owner_id = $1
    ORDER BY b.updated_at DESC
    LIMIT $2`, [ownerId, limit]);
  return rows;
}

// Rehydrates a stored battle into the in-memory shape lobbyManager uses.
async function loadBattle(token) {
  if (!enabled) return null;
  const { rows: brows } = await query(`SELECT * FROM battles WHERE token = $1`, [token]);
  const b = brows[0];
  if (!b) return null;

  const { rows: units } = await query(
    `SELECT bu.*, uc.display_name AS catalog_name
     FROM battle_units bu
     LEFT JOIN unit_catalog uc ON uc.id = bu.catalog_id
     WHERE bu.battle_id = $1`, [b.id]);
  const { rows: events } = await query(
    `SELECT * FROM battle_events WHERE battle_id = $1 ORDER BY seq`, [b.id]);

  return {
    dbId: b.id,
    ownerId: b.owner_id,
    token: b.token,
    meta: {
      name: b.name, mission: b.mission,
      date: b.fought_on ? new Date(b.fought_on).toISOString().slice(0, 10) : '',
      sides: {
        A: { name: b.side_a_name, faction: b.side_a_faction ?? '' },
        B: { name: b.side_b_name, faction: b.side_b_faction ?? '' },
      },
    },
    roster: units.map(u => ({
      id: u.id, name: u.name, catalogName: u.catalog_name || u.name,
      side: u.side, kind: u.kind, points: u.points ?? 0,
      startingStrength: u.starting_strength, size: u.size, color: u.color,
    })),
    log: events.map(rowToEvent),
  };
}

function rowToEvent(r) {
  const ev = {
    id: r.event_uuid, seq: r.seq, ts: new Date(r.ts).getTime(),
    round: r.round, side: r.side, phase: r.phase, type: r.type,
  };
  switch (r.type) {
    case 'deploy': Object.assign(ev, { unitId: r.actor_unit_id, x: r.from_x, y: r.from_y }); break;
    case 'move':   Object.assign(ev, {
      unitId: r.actor_unit_id, moveType: r.move_type,
      from: r.from_x !== null ? { x: r.from_x, y: r.from_y } : null,
      to: { x: r.to_x, y: r.to_y } }); break;
    case 'shoot':  Object.assign(ev, { shooterId: r.actor_unit_id,  targetId: r.target_unit_id, effect: r.effect }); break;
    case 'fight':  Object.assign(ev, { attackerId: r.actor_unit_id, targetId: r.target_unit_id, effect: r.effect }); break;
    case 'charge': Object.assign(ev, { chargerId: r.actor_unit_id,  targetId: r.target_unit_id, success: r.success }); break;
    case 'battleshock': Object.assign(ev, { unitId: r.actor_unit_id, passed: r.passed }); break;
    case 'score':  Object.assign(ev, { vp: r.vp, kind: r.score_kind, label: r.label }); break;
    case 'cp':     Object.assign(ev, { delta: r.cp_delta, reason: r.label }); break;
    case 'destroy':Object.assign(ev, { unitId: r.actor_unit_id }); break;
    case 'note':   Object.assign(ev, { text: r.text }); break;
  }
  return ev;
}

module.exports = {
  enabled, init, query, pool,
  upsertUser,
  normName, resolveCatalogId,
  createBattleRow, updateBattleMeta, claimBattle,
  insertUnit, deleteUnit,
  insertEvent, deleteEventBySeq,
  listBattles, loadBattle,
};
