'use strict';

// ─────────────────────────────────────────────────────────────────────────
// AD-7 — the log is the source of truth.
//
// Pure functions only: no DOM, no sockets. Board state at any point in the
// battle is derived by folding the event log up to a sequence number. This
// file is deliberately dependency-free so the report export can inline it.
// ─────────────────────────────────────────────────────────────────────────

const PHASES = ['command', 'movement', 'shooting', 'charge', 'fight'];
const SIDES  = ['A', 'B'];

const PHASE_LABEL = {
  command:  'Command',
  movement: 'Movement',
  shooting: 'Shooting',
  charge:   'Charge',
  fight:    'Fight',
};

// The 5-point effectiveness scale — the whole "roughly how effective" idea.
const EFFECTS = ['whiff', 'light', 'moderate', 'heavy', 'wiped'];

const EFFECT_META = {
  whiff:    { label: 'Whiff',    short: 'W', color: '#5a6b8c', cost: 0.00, phrase: 'to no effect' },
  light:    { label: 'Light',    short: 'L', color: '#81c784', cost: 0.10, phrase: 'for light damage' },
  moderate: { label: 'Moderate', short: 'M', color: '#ffb74d', cost: 0.33, phrase: 'for moderate damage' },
  heavy:    { label: 'Heavy',    short: 'H', color: '#f4713f', cost: 0.66, phrase: 'for heavy damage' },
  wiped:    { label: 'Wiped',    short: 'X', color: '#e94560', cost: 1.00, phrase: 'wiping it out' },
};

const MOVE_LABEL = {
  stationary: 'held position',
  normal:     'moved',
  advance:    'advanced',
  fallback:   'fell back',
  reserves:   'went into reserves',
};

// ── Cursor helpers ───────────────────────────────────────────────────────

function cursorIndex({ round, side, phase }) {
  return ((round - 1) * SIDES.length + SIDES.indexOf(side)) * PHASES.length
       + PHASES.indexOf(phase);
}

function cursorFromIndex(i) {
  const phase = PHASES[i % PHASES.length];
  const rest  = Math.floor(i / PHASES.length);
  const side  = SIDES[rest % SIDES.length];
  const round = Math.floor(rest / SIDES.length) + 1;
  return { round, side, phase };
}

function cursorLabel({ round, side, phase }, meta) {
  const sideName = meta?.sides?.[side]?.name || `Player ${side}`;
  return `R${round} · ${sideName} · ${PHASE_LABEL[phase]}`;
}

// True when event `ev` happened at or before `cursor`.
function eventWithinCursor(ev, cursor) {
  return cursorIndex(ev) <= cursorIndex(cursor);
}

// ── The fold ─────────────────────────────────────────────────────────────

// Derives the state of every unit by replaying the log.
// `upto` may be a seq number (Infinity for the whole log) — the sole way
// board state is ever produced.
function foldLog(log, roster, upto = Infinity) {
  const state = new Map();

  for (const def of roster) {
    state.set(def.id, {
      id:            def.id,
      def,
      x:             null,
      y:             null,
      strength:      def.startingStrength,
      status:        'reserves',   // reserves | active | destroyed
      battleShocked: false,
      deployed:      false,
    });
  }

  for (const ev of log) {
    if (ev.seq > upto) break;
    applyEvent(state, ev);
  }
  resolveAttachments(state);
  return state;
}

// A leader attached to a bodyguard occupies the same space and moves with it,
// so its position is derived rather than logged. If the bodyguard dies the
// leader is left on its own — it keeps the last shared position and becomes
// an independent unit from that point, which is what happens on the table.
function resolveAttachments(state) {
  for (const u of state.values()) {
    const bodyId = u.def.attachedTo;
    if (!bodyId) { u.attachedTo = null; u.leaders = u.leaders ?? []; continue; }

    const body = state.get(bodyId);
    if (!body || body.status === 'destroyed') {
      u.attachedTo = null;                       // bodyguard gone — on its own
      if (body && u.x === null) { u.x = body.x; u.y = body.y; u.deployed = body.deployed; }
      continue;
    }
    u.attachedTo = bodyId;
    u.x = body.x; u.y = body.y;
    u.deployed = body.deployed;
    if (u.status !== 'destroyed') u.status = body.status;
    (body.leaders ??= []).push(u.id);
  }
  for (const u of state.values()) u.leaders ??= [];
}

function applyEvent(state, ev) {
  switch (ev.type) {
    case 'deploy': {
      const u = state.get(ev.unitId);
      if (!u) break;
      u.x = ev.x; u.y = ev.y;
      u.status = 'active';
      u.deployed = true;
      break;
    }

    case 'move': {
      const u = state.get(ev.unitId);
      if (!u) break;
      u.x = ev.to.x; u.y = ev.to.y;
      u.deployed = true;
      if (u.status !== 'destroyed') {
        u.status = ev.moveType === 'reserves' ? 'reserves' : 'active';
      }
      break;
    }

    case 'shoot':
    case 'fight': {
      const t = state.get(ev.targetId);
      if (t) applyEffect(t, ev.effect);
      break;
    }

    case 'battleshock': {
      const u = state.get(ev.unitId);
      if (u) u.battleShocked = !ev.passed;
      break;
    }

    case 'destroy': {
      const u = state.get(ev.unitId);
      if (u) { u.status = 'destroyed'; u.strength = 0; }
      break;
    }

    // charge / score / cp / note carry no board-state change
  }
}

// Attrition is advisory — broad strokes, never bookkeeping (AD-7).
function applyEffect(unit, effect) {
  const meta = EFFECT_META[effect];
  if (!meta || unit.status === 'destroyed') return;
  const start = unit.def.startingStrength || 0;
  unit.strength = Math.max(0, unit.strength - start * meta.cost);
  if (effect === 'wiped' || (start > 0 && unit.strength <= 0)) {
    unit.status = 'destroyed';
    unit.strength = 0;
  }
}

// ── Derived tallies ──────────────────────────────────────────────────────

function tally(log, upto = Infinity) {
  const vp = { A: 0, B: 0 };
  const cp = { A: 0, B: 0 };
  for (const ev of log) {
    if (ev.seq > upto) break;
    if (ev.type === 'score' && vp[ev.side] !== undefined) vp[ev.side] += ev.vp;
    if (ev.type === 'cp'    && cp[ev.side] !== undefined) cp[ev.side] += ev.delta;
  }
  return { vp, cp };
}

// Damage dealt per unit — used by the report's "most effective" table.
function damageTally(log, roster) {
  const byUnit = new Map();
  const name = id => roster.find(u => u.id === id)?.name ?? 'Unknown';

  for (const ev of log) {
    if (ev.type !== 'shoot' && ev.type !== 'fight') continue;
    const actorId = ev.shooterId ?? ev.attackerId;
    if (!actorId) continue;
    const rec = byUnit.get(actorId) ?? {
      id: actorId, name: name(actorId), attacks: 0, score: 0, kills: 0,
    };
    rec.attacks++;
    rec.score += EFFECT_META[ev.effect]?.cost ?? 0;
    if (ev.effect === 'wiped') rec.kills++;
    byUnit.set(actorId, rec);
  }
  return [...byUnit.values()].sort((a, b) => b.score - a.score);
}

// ── Narrative generation ─────────────────────────────────────────────────

// Turns the log into readable prose, grouped by round → side → phase.
function narrate(log, roster, meta) {
  const nameOf = id => roster.find(u => u.id === id)?.name ?? 'a unit';
  const sideName = s => meta?.sides?.[s]?.name || `Player ${s}`;
  const rounds = [];

  for (const ev of log) {
    let round = rounds.find(r => r.round === ev.round);
    if (!round) { round = { round: ev.round, turns: [] }; rounds.push(round); }

    let turn = round.turns.find(t => t.side === ev.side);
    if (!turn) { turn = { side: ev.side, name: sideName(ev.side), phases: [] }; round.turns.push(turn); }

    let phase = turn.phases.find(p => p.phase === ev.phase);
    if (!phase) { phase = { phase: ev.phase, label: PHASE_LABEL[ev.phase], lines: [] }; turn.phases.push(phase); }

    const line = describe(ev, nameOf, sideName);
    if (line) phase.lines.push({ text: line, effect: ev.effect ?? null, type: ev.type });
  }

  rounds.sort((a, b) => a.round - b.round);
  for (const r of rounds) {
    r.turns.sort((a, b) => SIDES.indexOf(a.side) - SIDES.indexOf(b.side));
    for (const t of r.turns) {
      t.phases.sort((a, b) => PHASES.indexOf(a.phase) - PHASES.indexOf(b.phase));
    }
  }
  return rounds;
}

function describe(ev, nameOf, sideName) {
  switch (ev.type) {
    case 'deploy':
      return `${nameOf(ev.unitId)} deployed.`;

    case 'move': {
      const verb = MOVE_LABEL[ev.moveType] ?? 'moved';
      if (ev.moveType === 'stationary') return `${nameOf(ev.unitId)} ${verb}.`;
      const dist = ev.from ? distance(ev.from, ev.to) : null;
      return dist !== null && dist >= 0.5
        ? `${nameOf(ev.unitId)} ${verb} ${dist.toFixed(1)}".`
        : `${nameOf(ev.unitId)} ${verb}.`;
    }

    case 'shoot':
      return `${nameOf(ev.shooterId)} shot ${nameOf(ev.targetId)} ` +
             `${EFFECT_META[ev.effect]?.phrase ?? ''}.`;

    case 'fight':
      return `${nameOf(ev.attackerId)} fought ${nameOf(ev.targetId)} ` +
             `${EFFECT_META[ev.effect]?.phrase ?? ''}.`;

    case 'charge':
      return ev.success
        ? `${nameOf(ev.chargerId)} charged ${nameOf(ev.targetId)} successfully.`
        : `${nameOf(ev.chargerId)} failed a charge against ${nameOf(ev.targetId)}.`;

    case 'battleshock':
      return ev.passed
        ? `${nameOf(ev.unitId)} passed battle-shock.`
        : `${nameOf(ev.unitId)} failed battle-shock.`;

    case 'score':
      return `${sideName(ev.side)} scored ${ev.vp} VP` +
             (ev.label ? ` (${ev.label}).` : ` (${ev.kind}).`);

    case 'cp':
      return `${sideName(ev.side)} ${ev.delta >= 0 ? 'gained' : 'spent'} ` +
             `${Math.abs(ev.delta)} CP${ev.reason ? ` on ${ev.reason}` : ''}.`;

    case 'destroy':
      return `${nameOf(ev.unitId)} was destroyed.`;

    case 'note':
      return ev.text;
  }
  return null;
}

function distance(a, b) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

// Expose for both the app and the exported report.
const Battle = {
  PHASES, SIDES, PHASE_LABEL, EFFECTS, EFFECT_META, MOVE_LABEL,
  cursorIndex, cursorFromIndex, cursorLabel, eventWithinCursor,
  foldLog, tally, damageTally, narrate, distance,
};

if (typeof window !== 'undefined') window.Battle = Battle;
if (typeof module !== 'undefined') module.exports = Battle;
