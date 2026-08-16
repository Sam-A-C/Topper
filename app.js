'use strict';

// ── State ──────────────────────────────────────────────────────────────────
let mySocketId  = null;
let battleToken = null;

let meta   = { name: '', date: '', mission: '', sides: { A: {}, B: {} } };
let roster = [];                                   // UnitDef[]
let log    = [];                                   // Event[] — source of truth (AD-7)
let cursor = { round: 1, side: 'A', phase: 'command' };

let unitState = new Map();      // derived via Battle.foldLog — never written directly
let viewSeq   = Infinity;       // replay position; Infinity = live

const players = new Map();      // socketId → { username, color }
const locks   = new Map();      // unitId → socketId

// Selection drives the entry bar: click actor then target on the canvas.
const sel = { actorId: null, targetId: null };

// Movement-phase mode — chosen once, applied to every drag.
let moveType = 'normal';

const drag = { active: false, unitId: null, pending: null, offsetX: 0, offsetY: 0,
               preview: null, origin: null };

const ctxMenu = { worldX: 0, worldY: 0, targetId: null };

let replay = null;              // { seq, target, raf } while playing
let recorder = null;

// ── Canvas ─────────────────────────────────────────────────────────────────
const canvas = document.getElementById('battle-canvas');
const ctx    = canvas.getContext('2d');

function resizeCanvas() {
  const wrap = document.getElementById('canvas-wrap');
  canvas.width  = wrap.clientWidth;
  canvas.height = wrap.clientHeight;
}
window.addEventListener('resize', () => { resizeCanvas(); fitCamera(); });

// ── Board layout (AD-1: world space, 1 unit = 1 inch) ──────────────────────
const camera = { x: 0, y: 0, zoom: 1 };
const PX_PER_INCH = 60;

// Orientation is a setting; reserves sit on the short edges either way.
const RESERVE_DEPTH = 13;
let BOARD    = { x: 0, y: 0, w: 60, h: 44 };
let RESERVES = {};

function applyOrientation() {
  const landscape = Theme.boardOrientation() === 'landscape';
  BOARD = landscape ? { x: 0, y: 0, w: 60, h: 44 } : { x: 0, y: 0, w: 44, h: 60 };
  RESERVES = landscape
    ? { A: { x: -RESERVE_DEPTH, y: 0, w: RESERVE_DEPTH, h: BOARD.h },
        B: { x: BOARD.w,        y: 0, w: RESERVE_DEPTH, h: BOARD.h } }
    : { A: { x: 0, y: -RESERVE_DEPTH, w: BOARD.w, h: RESERVE_DEPTH },
        B: { x: 0, y: BOARD.h,        w: BOARD.w, h: RESERVE_DEPTH } };
}
applyOrientation();

// Canvas colours come from the live CSS tokens so the board can never
// disagree with the chrome around it. Refreshed on every theme change.
let PAL = null;
function pal() { return PAL ?? (PAL = Theme.palette()); }

function w2s(wx, wy) {
  return {
    x: (wx - camera.x) * camera.zoom * PX_PER_INCH,
    y: (wy - camera.y) * camera.zoom * PX_PER_INCH,
  };
}
function s2w(sx, sy) {
  return {
    x: sx / (camera.zoom * PX_PER_INCH) + camera.x,
    y: sy / (camera.zoom * PX_PER_INCH) + camera.y,
  };
}

function fitCamera() {
  const landscape = Theme.boardOrientation() === 'landscape';
  const totalW = BOARD.w + (landscape ? RESERVE_DEPTH * 2 : 0);
  const totalH = BOARD.h + (landscape ? 0 : RESERVE_DEPTH * 2);
  const margin = 28;
  // Clamped to the same range as scroll-zoom: called before layout settles,
  // canvas dimensions can be tiny or zero and would otherwise yield a zoom
  // of ~0 (or NaN), which renders nothing and breaks sub-pixel geometry.
  camera.zoom = Math.max(0.05, Math.min(8, Math.min(
    (canvas.width  - margin * 2) / (totalW * PX_PER_INCH),
    (canvas.height - margin * 2) / (totalH * PX_PER_INCH),
  ) || 0.05));
  camera.x = BOARD.w / 2 - canvas.width  / 2 / (camera.zoom * PX_PER_INCH);
  camera.y = BOARD.h / 2 - canvas.height / 2 / (camera.zoom * PX_PER_INCH);
}

// ── Fold: the only way board state is produced ─────────────────────────────
function recompute() {
  unitState = Battle.foldLog(log, roster, viewSeq);
  layoutReserves();
}

// Undeployed units sit in their side's reserves strip so they can simply be
// dragged onto the board — deployment needs no separate UI.
function layoutReserves() {
  for (const side of ['A', 'B']) {
    const zone = RESERVES[side];
    const waiting = [...unitState.values()].filter(
      u => u.def.side === side && !u.deployed && u.status !== 'destroyed');
    waiting.forEach((u, i) => {
      const perRow = Math.max(1, Math.floor(zone.w / 3.2));
      const col = i % perRow, row = Math.floor(i / perRow);
      u.x = zone.x + 2 + col * 3.2;
      u.y = zone.y + 2.4 + row * 3.4;
    });
  }
}

// ── Render ─────────────────────────────────────────────────────────────────
function render() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  drawZone(RESERVES.A, sideName('A') + ' — Reserves', pal().sideA);
  drawBoard();
  drawZone(RESERVES.B, sideName('B') + ' — Reserves', pal().sideB);

  drawRecentLines();

  for (const u of unitState.values()) drawUnit(u);

  requestAnimationFrame(render);
}

function drawBoard() {
  const p = pal();
  const tl = w2s(BOARD.x, BOARD.y);
  const br = w2s(BOARD.x + BOARD.w, BOARD.y + BOARD.h);
  const w = br.x - tl.x, h = br.y - tl.y;

  ctx.fillStyle = p.felt;
  ctx.fillRect(tl.x, tl.y, w, h);

  // grid every 6"
  ctx.strokeStyle = p.grid;
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  ctx.beginPath();
  for (let x = 6; x < BOARD.w; x += 6) {
    const sx = w2s(x, 0).x;
    ctx.moveTo(sx, tl.y); ctx.lineTo(sx, br.y);
  }
  for (let y = 6; y < BOARD.h; y += 6) {
    const sy = w2s(0, y).y;
    ctx.moveTo(tl.x, sy); ctx.lineTo(br.x, sy);
  }
  ctx.stroke();

  ctx.strokeStyle = p.feltEdge;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(tl.x, tl.y, w, h);
}

function drawZone(z, label, color) {
  const p = pal();
  const tl = w2s(z.x, z.y);
  const br = w2s(z.x + z.w, z.y + z.h);
  const w = br.x - tl.x, h = br.y - tl.y;

  ctx.fillStyle = p.reserve;
  ctx.fillRect(tl.x, tl.y, w, h);
  ctx.strokeStyle = p.reserveEdge;
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.strokeRect(tl.x, tl.y, w, h);
  ctx.setLineDash([]);

  ctx.fillStyle = withAlpha(color, 0.55);
  ctx.font = `600 ${Math.max(9, 10 * camera.zoom)}px ${p.fontUi}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(label, tl.x + 6, tl.y + 5);
}

// Flash the most recent shoot/charge/fight of the current phase as a line.
function drawRecentLines() {
  const recent = log.filter(e =>
    e.seq <= viewSeq &&
    e.round === cursor.round && e.side === cursor.side && e.phase === cursor.phase &&
    (e.type === 'shoot' || e.type === 'fight' || e.type === 'charge'));

  for (const ev of recent.slice(-6)) {
    const a = unitState.get(ev.shooterId ?? ev.attackerId ?? ev.chargerId);
    const b = unitState.get(ev.targetId);
    if (!a || !b || a.x === null || b.x === null) continue;

    const pa = w2s(a.x, a.y), pb = w2s(b.x, b.y);
    const color = ev.type === 'charge'
      ? (ev.success ? pal().effect.light : pal().effect.whiff)
      : effectColor(ev.effect);

    ctx.strokeStyle = withAlpha(color, 0.55);
    ctx.lineWidth = ev.type === 'charge' ? 2 : 1.5;
    ctx.setLineDash(ev.type === 'charge' ? [] : [5, 4]);
    ctx.beginPath();
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

function drawUnit(u) {
  if (u.x === null || u.y === null) return;

  // dragging shows a local preview so the drag feels instant (AD-3)
  const pos = (drag.active && drag.unitId === u.id && drag.preview) ? drag.preview : u;
  const p = w2s(pos.x, pos.y);
  const r = (u.def.size / 2) * camera.zoom * PX_PER_INCH;
  const destroyed = u.status === 'destroyed';

  const P = pal();
  const unitColor = u.def.kind === 'unit'
    ? (u.def.side === 'B' ? P.sideB : P.sideA)
    : u.def.kind === 'objective' ? P.objective : P.terrain;

  ctx.globalAlpha = destroyed ? 0.28 : 1;

  if (u.def.kind === 'terrain') {
    ctx.fillStyle = P.terrain;
    ctx.strokeStyle = P.terrainEdge;
    ctx.lineWidth = 1;
    roundRect(ctx, p.x - r, p.y - r, r * 2, r * 2, 4);
    ctx.fill(); ctx.stroke();
  } else if (u.def.kind === 'objective') {
    ctx.fillStyle = withAlpha(P.objective, 0.18);
    ctx.strokeStyle = P.objective;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill(); ctx.stroke();
    ctx.setLineDash([]);
  } else {
    // unit: filled disc with a strength arc
    if (P.glowBoard && !destroyed) {
      ctx.shadowColor = unitColor;
      ctx.shadowBlur = Math.max(6, r * 0.9);
    }
    ctx.fillStyle = unitColor;
    ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0;

    if (P.tokenStroke !== 'none') {
      ctx.strokeStyle = P.tokenStroke;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.stroke();
    }

    const frac = u.def.startingStrength
      ? Math.max(0, Math.min(1, u.strength / u.def.startingStrength)) : 1;
    // The inset arc is only drawn when the token is big enough to hold it —
    // below that, r minus the clamped stroke width would go negative and
    // arc() throws, taking the whole render loop down.
    const lw = Math.max(2, r * 0.3);
    const arcR = r - lw / 2;
    if (frac < 1 && !destroyed && arcR > 0.5) {
      ctx.strokeStyle = 'rgba(0,0,0,0.45)';
      ctx.lineWidth = lw;
      ctx.beginPath();
      ctx.arc(p.x, p.y, arcR,
              -Math.PI / 2 + Math.PI * 2 * frac, -Math.PI / 2 + Math.PI * 2);
      ctx.stroke();
    }
    if (destroyed) {
      ctx.strokeStyle = P.effect.wiped;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(p.x - r * 0.6, p.y - r * 0.6); ctx.lineTo(p.x + r * 0.6, p.y + r * 0.6);
      ctx.moveTo(p.x + r * 0.6, p.y - r * 0.6); ctx.lineTo(p.x - r * 0.6, p.y + r * 0.6);
      ctx.stroke();
    }
  }

  // selection / lock rings
  const isActor  = sel.actorId  === u.id;
  const isTarget = sel.targetId === u.id;
  const heldBy   = locks.get(u.id);

  if (isActor || isTarget || heldBy) {
    ctx.strokeStyle = isActor ? P.text : isTarget ? P.effect.moderate
                    : players.get(heldBy)?.color ?? P.text;
    ctx.lineWidth = 2.5;
    ctx.setLineDash(isTarget ? [4, 3] : []);
    ctx.beginPath(); ctx.arc(p.x, p.y, r + 3, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
  }

  if (u.battleShocked && !destroyed) {
    ctx.fillStyle = P.effect.moderate;
    ctx.beginPath(); ctx.arc(p.x + r * 0.75, p.y - r * 0.75, Math.max(2.5, r * 0.26), 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.globalAlpha = 1;

  // label under the token
  const fs = Math.max(8, 9.5 * camera.zoom);
  if (fs >= 7) {
    ctx.fillStyle = destroyed ? P.textMuted : P.boardLabel;
    ctx.font = `${P.labelWeight} ${fs}px ${P.fontUi}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(u.def.name, p.x, p.y + r + 3);
  }
}

function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y,     x + w, y + h, r);
  c.arcTo(x + w, y + h, x,     y + h, r);
  c.arcTo(x,     y + h, x,     y,     r);
  c.arcTo(x,     y,     x + w, y,     r);
  c.closePath();
}

// battle.js keeps neutral fallback colours so an exported report renders
// standalone; the live UI overrides them from the active theme.
function effectColor(effect) {
  return pal().effect[effect] ?? Battle.EFFECT_META[effect]?.color ?? pal().textMuted;
}

// Theme tokens may be hex or already-rgba, so handle both rather than
// assuming the hex form the old hardcoded palette used.
function withAlpha(color, a) {
  const c = String(color).trim();
  if (c.startsWith('#')) {
    const hex = c.length === 4
      ? c.slice(1).split('').map(ch => ch + ch).join('')
      : c.slice(1, 7);
    const n = parseInt(hex, 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }
  const m = c.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const [r, g, b] = m[1].split(',').map(s => parseFloat(s));
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  }
  return c;
}

function sideName(s) { return meta.sides?.[s]?.name || `Player ${s}`; }

// ── Hit-testing ────────────────────────────────────────────────────────────
function hitTest(wx, wy) {
  const all = [...unitState.values()].filter(u => u.x !== null);
  // units before terrain so a unit standing on a ruin is grabbed first
  all.sort((a, b) => rank(b.def.kind) - rank(a.def.kind));
  for (const u of all) {
    const r = u.def.size / 2;
    if (Math.hypot(wx - u.x, wy - u.y) <= r) return u;
  }
  return null;
}
function rank(kind) { return kind === 'unit' ? 2 : kind === 'objective' ? 1 : 0; }

// ── Canvas input ───────────────────────────────────────────────────────────
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
  const wx = e.offsetX / (camera.zoom * PX_PER_INCH) + camera.x;
  const wy = e.offsetY / (camera.zoom * PX_PER_INCH) + camera.y;
  camera.zoom = Math.max(0.05, Math.min(8, camera.zoom * factor));
  camera.x = wx - e.offsetX / (camera.zoom * PX_PER_INCH);
  camera.y = wy - e.offsetY / (camera.zoom * PX_PER_INCH);
}, { passive: false });

// Panning: middle-button anywhere, or left-drag on empty board. A left press
// on empty space is ambiguous until the mouse moves, so the deselect is
// deferred to mouseup and only fires if this turned out to be a click.
const pan = { active: false, sx: 0, sy: 0, camX: 0, camY: 0, moved: false, deselect: false };

function startPan(e, deselect) {
  pan.active = true;
  pan.sx = e.clientX; pan.sy = e.clientY;
  pan.camX = camera.x; pan.camY = camera.y;
  pan.moved = false;
  pan.deselect = !!deselect;
  canvas.style.cursor = 'grabbing';
}

function endPan() {
  if (!pan.active) return;
  if (!pan.moved && pan.deselect) {
    sel.actorId = null; sel.targetId = null;
    renderEntryBar(); renderRoster();
  }
  pan.active = false;
  canvas.style.cursor = '';
}

canvas.addEventListener('mousedown', (e) => {
  if (e.button === 1) { e.preventDefault(); hideContextMenu(); startPan(e, false); return; }
  if (e.button !== 0) return;
  hideContextMenu();
  const { x: wx, y: wy } = s2w(e.offsetX, e.offsetY);
  const u = hitTest(wx, wy);

  if (!u) { startPan(e, true); return; }

  if (cursor.phase === 'movement') {
    drag.pending = u.id;
    drag.offsetX = wx - u.x;
    drag.offsetY = wy - u.y;
    drag.origin  = u.deployed ? { x: u.x, y: u.y } : null;
    emit('unit:grab', { id: u.id });
  } else {
    pickForEntry(u);
  }
});

canvas.addEventListener('mousemove', (e) => {
  if (pan.active) {
    const dx = e.clientX - pan.sx, dy = e.clientY - pan.sy;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) pan.moved = true;
    const scale = camera.zoom * PX_PER_INCH;
    camera.x = pan.camX - dx / scale;
    camera.y = pan.camY - dy / scale;
    return;
  }
  if (!drag.active) return;
  const { x: wx, y: wy } = s2w(e.offsetX, e.offsetY);
  drag.preview = { x: wx - drag.offsetX, y: wy - drag.offsetY };
  emit('unit:drag', { id: drag.unitId, x: drag.preview.x, y: drag.preview.y });
});

canvas.addEventListener('mouseup', () => { endPan(); finishDrag(); });
canvas.addEventListener('mouseleave', () => { endPan(); finishDrag(); });
// A drag often ends outside the canvas; without this the board would stay
// stuck to the cursor after releasing over the sidebar.
window.addEventListener('mouseup', () => { endPan(); });
canvas.addEventListener('auxclick', (e) => { if (e.button === 1) e.preventDefault(); });

// On release the drag becomes an event — the log is the only write path.
function finishDrag() {
  if (!drag.active) { drag.pending = null; return; }
  const u = unitState.get(drag.unitId);
  const to = drag.preview;

  if (u && to) {
    if (!u.deployed) {
      appendEvent({ type: 'deploy', unitId: u.id, x: to.x, y: to.y });
    } else {
      appendEvent({ type: 'move', unitId: u.id, from: drag.origin, to, moveType });
    }
  }
  emit('unit:release', { id: drag.unitId });

  drag.active = false; drag.unitId = null; drag.pending = null;
  drag.preview = null; drag.origin = null;
}

// Clicking units fills the entry bar: own side = actor, enemy = target.
function pickForEntry(u) {
  if (u.def.kind !== 'unit') return;
  if (cursor.phase === 'command') {
    sel.actorId = u.id; sel.targetId = null;
  } else if (u.def.side === cursor.side) {
    sel.actorId = u.id;
  } else {
    sel.targetId = u.id;
  }
  renderEntryBar();
}

// ── Context menu ───────────────────────────────────────────────────────────
canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const { x: wx, y: wy } = s2w(e.offsetX, e.offsetY);
  ctxMenu.worldX = wx; ctxMenu.worldY = wy;
  ctxMenu.targetId = hitTest(wx, wy)?.id ?? null;

  const menu = document.getElementById('context-menu');
  const hasTarget = ctxMenu.targetId !== null;
  document.getElementById('ctx-destroy').classList.toggle('hidden', !hasTarget);
  document.getElementById('ctx-remove').classList.toggle('hidden', !hasTarget);
  menu.querySelector('[data-action="deploy"]').classList.toggle('hidden', hasTarget);

  menu.style.left = e.clientX + 'px';
  menu.style.top  = e.clientY + 'px';
  menu.classList.remove('hidden');
});

document.getElementById('context-menu').addEventListener('click', (e) => {
  const action = e.target.dataset.action;
  if (!action) return;
  hideContextMenu();
  if (action === 'destroy' && ctxMenu.targetId) {
    appendEvent({ type: 'destroy', unitId: ctxMenu.targetId });
  } else if (action === 'remove-unit' && ctxMenu.targetId) {
    emit('unit:remove', { id: ctxMenu.targetId });
  }
});
window.addEventListener('click', hideContextMenu);
function hideContextMenu() {
  document.getElementById('context-menu').classList.add('hidden');
}

// ── Cursor / phase stepper ─────────────────────────────────────────────────
function renderCursor() {
  document.getElementById('cursor-round').textContent = 'R' + cursor.round;
  document.getElementById('cursor-side').textContent  = sideName(cursor.side);
  document.getElementById('cursor-phase').textContent = Battle.PHASE_LABEL[cursor.phase];

  const rail = document.getElementById('phase-rail');
  rail.innerHTML = '';
  for (const p of Battle.PHASES) {
    const el = document.createElement('button');
    el.className = 'rail-phase' + (p === cursor.phase ? ' active' : '');
    el.textContent = Battle.PHASE_LABEL[p];
    el.addEventListener('click', () => emit('battle:setCursor', { ...cursor, phase: p }));
    rail.appendChild(el);
  }
  rail.dataset.activeSide = cursor.side;
}

document.getElementById('btn-step-back').addEventListener('click',
  () => emit('battle:stepCursor', { dir: -1 }));
document.getElementById('btn-step-fwd').addEventListener('click',
  () => emit('battle:stepCursor', { dir: 1 }));

// ── Entry bar (phase-contextual, speed-critical) ───────────────────────────
function renderEntryBar() {
  const bar = document.getElementById('entry-bar');
  bar.innerHTML = '';

  const mine   = roster.filter(u => u.kind === 'unit' && u.side === cursor.side);
  const theirs = roster.filter(u => u.kind === 'unit' && u.side !== cursor.side);

  const alive = list => list.filter(u => unitState.get(u.id)?.status !== 'destroyed');

  switch (cursor.phase) {
    case 'command': {
      bar.appendChild(unitPicker('Unit', alive(mine), 'actorId'));
      bar.appendChild(btn('Passed', 'ok', () => {
        if (sel.actorId) appendEvent({ type: 'battleshock', unitId: sel.actorId, passed: true });
      }));
      bar.appendChild(btn('Failed', 'bad', () => {
        if (sel.actorId) appendEvent({ type: 'battleshock', unitId: sel.actorId, passed: false });
      }));
      bar.appendChild(divider());
      bar.appendChild(tag('VP'));
      for (const n of [1, 2, 3, 4, 5]) {
        bar.appendChild(btn('+' + n, '', () =>
          appendEvent({ type: 'score', side: cursor.side, vp: n, kind: 'primary' })));
      }
      bar.appendChild(divider());
      bar.appendChild(tag('CP'));
      bar.appendChild(btn('−1', '', () =>
        appendEvent({ type: 'cp', side: cursor.side, delta: -1 })));
      bar.appendChild(btn('+1', '', () =>
        appendEvent({ type: 'cp', side: cursor.side, delta: 1 })));
      break;
    }

    case 'movement': {
      bar.appendChild(tag('Drag units on the board'));
      bar.appendChild(divider());
      for (const [key, label] of Object.entries({
        stationary: 'Stationary', normal: 'Normal', advance: 'Advance', fallback: 'Fall Back',
      })) {
        const b = btn(label, moveType === key ? 'chip-on' : 'chip', () => {
          moveType = key;
          if (key === 'stationary' && sel.actorId) {
            const u = unitState.get(sel.actorId);
            if (u) appendEvent({ type: 'move', unitId: u.id,
                                 from: { x: u.x, y: u.y }, to: { x: u.x, y: u.y },
                                 moveType: 'stationary' });
          }
          renderEntryBar();
        });
        bar.appendChild(b);
      }
      break;
    }

    case 'shooting':
    case 'fight': {
      const isShoot = cursor.phase === 'shooting';
      bar.appendChild(unitPicker(isShoot ? 'Shooter' : 'Attacker', alive(mine), 'actorId'));
      bar.appendChild(tag(isShoot ? 'shot' : 'fought'));
      bar.appendChild(unitPicker('Target', alive(theirs), 'targetId'));
      bar.appendChild(divider());
      for (const eff of Battle.EFFECTS) {
        const m = Battle.EFFECT_META[eff];
        const b = btn(m.label, 'effect', () => {   // colour set below from theme
          if (!sel.actorId || !sel.targetId) { toast('Pick both units first'); return; }
          appendEvent({
            type: isShoot ? 'shoot' : 'fight',
            [isShoot ? 'shooterId' : 'attackerId']: sel.actorId,
            targetId: sel.targetId,
            effect: eff,
          });
          sel.targetId = null;   // keep the actor, clear the target
          renderEntryBar();
        });
        b.style.setProperty('--effect', effectColor(eff));
        bar.appendChild(b);
      }
      break;
    }

    case 'charge': {
      bar.appendChild(unitPicker('Charger', alive(mine), 'actorId'));
      bar.appendChild(tag('charged'));
      bar.appendChild(unitPicker('Target', alive(theirs), 'targetId'));
      bar.appendChild(divider());
      bar.appendChild(btn('Made it', 'ok', () => logCharge(true)));
      bar.appendChild(btn('Failed',  'bad', () => logCharge(false)));
      break;
    }
  }

  function logCharge(success) {
    if (!sel.actorId || !sel.targetId) { toast('Pick both units first'); return; }
    appendEvent({ type: 'charge', chargerId: sel.actorId, targetId: sel.targetId, success });
    sel.targetId = null;
    renderEntryBar();
  }
}

function unitPicker(label, list, slot) {
  const wrap = document.createElement('label');
  wrap.className = 'picker';
  const span = document.createElement('span');
  span.textContent = label;
  const select = document.createElement('select');

  const none = document.createElement('option');
  none.value = ''; none.textContent = '—';
  select.appendChild(none);

  for (const u of list) {
    const o = document.createElement('option');
    o.value = u.id; o.textContent = u.name;
    select.appendChild(o);
  }
  select.value = sel[slot] ?? '';
  select.addEventListener('change', () => { sel[slot] = select.value || null; });

  wrap.appendChild(span);
  wrap.appendChild(select);
  return wrap;
}

function btn(label, cls, onClick) {
  const b = document.createElement('button');
  b.className = 'entry-btn ' + (cls || '');
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}
function tag(text) {
  const s = document.createElement('span');
  s.className = 'entry-tag';
  s.textContent = text;
  return s;
}
function divider() {
  const d = document.createElement('span');
  d.className = 'entry-divider';
  return d;
}

// ── Sidebar ────────────────────────────────────────────────────────────────
function renderRoster() {
  const ul = document.getElementById('roster-list');
  ul.innerHTML = '';
  for (const def of roster) {
    const st = unitState.get(def.id);
    const li = document.createElement('li');
    li.className = 'roster-item';
    if (st?.status === 'destroyed') li.classList.add('dead');
    if (sel.actorId === def.id || sel.targetId === def.id) li.classList.add('picked');

    const dot = document.createElement('span');
    dot.className = 'roster-dot';
    dot.style.background = def.color;

    const name = document.createElement('span');
    name.className = 'roster-name';
    name.textContent = def.name;

    const badge = document.createElement('span');
    badge.className = 'roster-badge';
    badge.textContent = def.kind !== 'unit' ? def.kind
      : st?.status === 'destroyed' ? '✕'
      : st?.deployed ? strengthBadge(st, def)
      : 'res';

    li.append(dot, name, badge);
    li.addEventListener('click', () => { if (st) pickForEntry(st); renderRoster(); });
    ul.appendChild(li);
  }
}

// Multi-model units read as models remaining (what you remove from the table);
// single-model units read as a percentage, where a model count says nothing.
function strengthBadge(st, def) {
  const start = def.startingStrength || 0;
  if (start <= 1) {
    const pct = Math.round((start ? st.strength / start : 1) * 100);
    return pct + '%';
  }
  return Math.ceil(st.strength) + '/' + start;
}

function renderLog() {
  const ul = document.getElementById('event-log');
  ul.innerHTML = '';
  const here = log.filter(e => e.round === cursor.round
                            && e.side === cursor.side
                            && e.phase === cursor.phase);
  if (!here.length) {
    const li = document.createElement('li');
    li.className = 'log-empty';
    li.textContent = 'Nothing logged this phase.';
    ul.appendChild(li);
  }
  const nameOf = id => roster.find(u => u.id === id)?.name ?? '?';
  for (const ev of here) {
    const li = document.createElement('li');
    li.className = 'log-item';
    if (ev.effect) li.style.borderLeftColor = effectColor(ev.effect);
    li.textContent = describeShort(ev, nameOf);
    ul.appendChild(li);
  }
  ul.scrollTop = ul.scrollHeight;
}

function describeShort(ev, nameOf) {
  switch (ev.type) {
    case 'deploy':      return `${nameOf(ev.unitId)} deployed`;
    case 'move':        return `${nameOf(ev.unitId)} ${Battle.MOVE_LABEL[ev.moveType]}`;
    case 'shoot':       return `${nameOf(ev.shooterId)} → ${nameOf(ev.targetId)} · ${Battle.EFFECT_META[ev.effect].label}`;
    case 'fight':       return `${nameOf(ev.attackerId)} ⚔ ${nameOf(ev.targetId)} · ${Battle.EFFECT_META[ev.effect].label}`;
    case 'charge':      return `${nameOf(ev.chargerId)} ⇒ ${nameOf(ev.targetId)} · ${ev.success ? 'made it' : 'failed'}`;
    case 'battleshock': return `${nameOf(ev.unitId)} battle-shock ${ev.passed ? 'passed' : 'FAILED'}`;
    case 'score':       return `+${ev.vp} VP ${ev.label ? '· ' + ev.label : ''}`;
    case 'cp':          return `${ev.delta >= 0 ? '+' : ''}${ev.delta} CP`;
    case 'destroy':     return `${nameOf(ev.unitId)} destroyed`;
    case 'note':        return ev.text;
  }
  return ev.type;
}

function renderScores() {
  const { vp, cp } = Battle.tally(log);
  for (const s of ['A', 'B']) {
    document.getElementById('score-name-' + s).textContent = sideName(s);
    document.getElementById('score-vp-'   + s).textContent = vp[s];
    document.getElementById('score-cp-'   + s).textContent = cp[s] + ' CP';
  }
  document.querySelectorAll('.score-side').forEach(el =>
    el.classList.toggle('active', el.dataset.side === cursor.side));
}

function renderPlayers() {
  const ul = document.getElementById('player-list');
  ul.innerHTML = '';
  for (const [sid, p] of players) {
    const li = document.createElement('li');
    const isMe = sid === mySocketId;
    if (isMe) li.classList.add('is-me');
    const dot = document.createElement('span');
    dot.className = 'player-dot';
    dot.style.background = p.color;
    const name = document.createElement('span');
    name.className = 'player-name';
    name.textContent = p.username + (isMe ? ' (you)' : '');
    li.append(dot, name);
    if (isMe) li.addEventListener('click', () => startRename(li, name, sid));
    ul.appendChild(li);
  }
}

function startRename(li, nameSpan, sid) {
  if (li.querySelector('.player-name-input')) return;
  const input = document.createElement('input');
  input.className = 'player-name-input';
  input.value = players.get(sid)?.username ?? '';
  li.replaceChild(input, nameSpan);
  input.focus(); input.select();
  const commit = () => {
    const v = input.value.trim();
    if (v) emit('player:rename', { username: v });
    if (input.parentNode) li.replaceChild(nameSpan, input);
  };
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.blur();
    if (e.key === 'Escape') { input.value = ''; li.replaceChild(nameSpan, input); }
  });
}

function renderAll() {
  recompute();
  renderCursor();
  renderEntryBar();
  renderRoster();
  renderLog();
  renderScores();
}

// ── Report ─────────────────────────────────────────────────────────────────
function renderReport() {
  const body = document.getElementById('report-body');
  const { vp, cp } = Battle.tally(log);
  const rounds = Battle.narrate(log, roster, meta);
  const dmg = Battle.damageTally(log, roster);
  const finalState = Battle.foldLog(log, roster);

  const el = document.createElement('div');
  el.className = 'report-inner';

  const title = meta.name || 'Untitled Battle';
  const sub = [meta.mission, meta.date].filter(Boolean).join(' · ');
  el.innerHTML = `
    <div class="report-title">${esc(title)}</div>
    <div class="report-sub">${esc(sub)}</div>
    <div class="report-scoreline">
      ${scoreCard('A', vp, cp)}
      ${scoreCard('B', vp, cp)}
    </div>`;

  // narrative
  if (!rounds.length) {
    const p = document.createElement('p');
    p.className = 'report-empty';
    p.textContent = 'Nothing logged yet.';
    el.appendChild(p);
  }

  for (const r of rounds) {
    const rd = document.createElement('div');
    rd.className = 'report-round';
    rd.innerHTML = `<h2>Battle Round ${r.round}</h2>`;
    for (const t of r.turns) {
      const td = document.createElement('div');
      td.className = 'report-turn';
      td.innerHTML = `<h3>${esc(t.name)}</h3>`;
      for (const p of t.phases) {
        const pd = document.createElement('div');
        pd.className = 'report-phase';
        pd.innerHTML = `<h4>${p.label}</h4>` + p.lines.map(l => {
          const c = l.effect ? effectColor(l.effect) : null;
          return `<div class="report-line"${c ? ` style="border-left-color:${c}"` : ''}>${esc(l.text)}</div>`;
        }).join('');
        td.appendChild(pd);
      }
      rd.appendChild(td);
    }
    el.appendChild(rd);
  }

  // casualties + effectiveness
  const dead = [...finalState.values()].filter(u => u.status === 'destroyed');
  const extra = document.createElement('div');
  extra.className = 'report-round';
  extra.innerHTML = `
    <h2>Aftermath</h2>
    <h4 style="font-size:11px;color:var(--text-muted);letter-spacing:.9px;margin-bottom:4px;">CASUALTIES</h4>
    ${dead.length
      ? `<div>${dead.map(u => `<div class="report-line">${esc(u.def.name)} (${esc(sideName(u.def.side))})</div>`).join('')}</div>`
      : `<p class="report-empty">No units destroyed.</p>`}
    ${dmg.length ? `
      <table class="report-table">
        <thead><tr><th>Unit</th><th>Attacks</th><th>Kills</th><th>Impact</th></tr></thead>
        <tbody>${dmg.slice(0, 8).map(d => `
          <tr><td>${esc(d.name)}</td><td>${d.attacks}</td><td>${d.kills}</td>
              <td>${d.score.toFixed(2)}</td></tr>`).join('')}</tbody>
      </table>` : ''}`;
  el.appendChild(extra);

  body.innerHTML = '';
  body.appendChild(el);

  function scoreCard(side, vp, cp) {
    const win = vp[side] > vp[side === 'A' ? 'B' : 'A'];
    return `<div class="report-score${win ? ' winner' : ''}" data-side="${side}">
      <div class="rs-name">${esc(sideName(side))}${win ? ' — victor' : ''}</div>
      <div class="rs-vp">${vp[side]}</div>
      <div class="rs-name">${cp[side]} CP remaining</div>
    </div>`;
  }
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g,
    c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

document.getElementById('btn-report').addEventListener('click', () => {
  renderReport();
  show('screen-report');
});
document.getElementById('btn-back-to-battle').addEventListener('click', () => {
  viewSeq = Infinity;
  stopReplay();
  show('screen-battle');
  resizeCanvas(); fitCamera(); renderAll();
});

// ── Replay ─────────────────────────────────────────────────────────────────
// Walks viewSeq forward over the log, so the same fold that draws the live
// board also drives the animation. Positions tween between move events.

const REPLAY_MS_PER_EVENT = 420;

function startReplay(onDone) {
  if (!log.length) { toast('Nothing to replay'); return; }
  stopReplay();
  show('screen-battle');
  resizeCanvas(); fitCamera();

  const maxSeq = log[log.length - 1].seq;
  const t0 = performance.now();
  replay = { onDone };

  const tick = (now) => {
    if (!replay) return;
    // Time-based, not frame-based, so dropped frames never desync the replay.
    const idx  = (now - t0) / REPLAY_MS_PER_EVENT;
    const i    = Math.min(log.length - 1, Math.floor(idx));
    const frac = Math.min(1, idx - i);
    viewSeq = log[i].seq;

    // keep the cursor readout in step with what's on screen
    const ev = log[i];
    if (ev) {
      cursor = { round: ev.round, side: ev.side, phase: ev.phase };
      renderCursor();
    }
    recompute();
    tweenCurrent(ev, frac);

    if (viewSeq >= maxSeq && idx > log.length) { finishReplay(); return; }
    replay.raf = requestAnimationFrame(tick);
  };
  replay.raf = requestAnimationFrame(tick);
}

// The fold snaps a moving unit straight to its destination; during replay we
// ease it across so the movement reads as movement.
function tweenCurrent(ev, frac) {
  if (!ev || ev.type !== 'move' || !ev.from) return;
  const u = unitState.get(ev.unitId);
  if (!u) return;
  const e = frac < 0.5 ? 2 * frac * frac : 1 - Math.pow(-2 * frac + 2, 2) / 2; // ease-in-out
  u.x = ev.from.x + (ev.to.x - ev.from.x) * e;
  u.y = ev.from.y + (ev.to.y - ev.from.y) * e;
}

function finishReplay() {
  const done = replay?.onDone;
  stopReplay();
  viewSeq = Infinity;
  recompute();
  if (done) done();
}

function stopReplay() {
  if (replay?.raf) cancelAnimationFrame(replay.raf);
  replay = null;
}

document.getElementById('btn-replay').addEventListener('click', () => {
  startReplay(() => { renderReport(); show('screen-report'); });
});

// ── Video export ───────────────────────────────────────────────────────────
// canvas.captureStream + MediaRecorder — no dependencies, no build step.

document.getElementById('btn-record').addEventListener('click', async () => {
  if (recorder) { toast('Already recording'); return; }
  if (!log.length) { toast('Nothing to record'); return; }
  if (!window.MediaRecorder || !canvas.captureStream) {
    toast('Video export not supported in this browser'); return;
  }

  const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
    .find(m => MediaRecorder.isTypeSupported(m));
  if (!mime) { toast('No supported video format'); return; }

  // Canvas capture only produces frames while the page is actually painting,
  // so a backgrounded tab would record a frozen board.
  if (document.visibilityState !== 'visible') {
    toast('Keep this tab visible while recording'); return;
  }

  const chunks = [];
  const stream = canvas.captureStream(30);
  recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 4_000_000 });
  recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
  recorder.onstop = () => {
    const blob = new Blob(chunks, { type: 'video/webm' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (meta.name || 'battle').replace(/[^\w-]+/g, '_') + '-replay.webm';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    recorder = null;
    toast('Video saved');
  };

  toast('Recording replay…');
  recorder.start();
  startReplay(() => {
    // let the final frame land before cutting
    setTimeout(() => { if (recorder?.state === 'recording') recorder.stop(); }, 700);
  });
});

// ── JSON export / import ───────────────────────────────────────────────────
// Versioned so old exports stay readable, and round-trips through import:
// meta + roster + the full event log is everything needed to rebuild a battle.

const EXPORT_VERSION = 1;

document.getElementById('btn-export-json').addEventListener('click', () => {
  const payload = {
    schema: 'topper.battle',
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    token: battleToken,
    meta, roster, log,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = (meta.name || 'battle').replace(/[^\w-]+/g, '_') + '.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
});

document.getElementById('btn-import').addEventListener('click',
  () => document.getElementById('import-file').click());

document.getElementById('import-file').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  let data;
  try { data = JSON.parse(await file.text()); }
  catch { setHomeError('That file is not valid JSON.'); return; }

  if (data.schema !== 'topper.battle' || !Array.isArray(data.log)) {
    setHomeError('That does not look like a Topper battle export.'); return;
  }
  if (data.version > EXPORT_VERSION) {
    setHomeError('That export came from a newer version of Topper.'); return;
  }
  setHomeError('');
  importBattle(data);
});

// Replays an export into a fresh battle. Unit ids are remapped because the
// server mints its own, so every event is rewritten to the new ids.
async function importBattle(data) {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  openSocket();
  emit('battle:start', {});
  await wait(400);
  if (!battleToken) { setHomeError('Could not reach the server.'); return; }

  if (data.meta) emit('meta:set', data.meta);

  const idMap = new Map();
  const pending = (data.roster ?? []).map(u => u.id);
  for (const u of data.roster ?? []) {
    emit('unit:add', {
      name: u.name, side: u.side, kind: u.kind,
      startingStrength: u.startingStrength, size: u.size,
    });
  }
  await wait(200 + pending.length * 60);

  // server preserves add order, so pair old ids to new by index
  pending.forEach((oldId, i) => { if (roster[i]) idMap.set(oldId, roster[i].id); });

  const remap = id => idMap.get(id) ?? id;
  let lastCursor = null;

  for (const ev of data.log) {
    const c = `${ev.round}|${ev.side}|${ev.phase}`;
    if (c !== lastCursor) {
      emit('battle:setCursor', { round: ev.round, side: ev.side, phase: ev.phase });
      lastCursor = c;
      await wait(40);
    }
    const out = { ...ev };
    delete out.id; delete out.seq; delete out.ts;
    for (const k of ['unitId', 'shooterId', 'attackerId', 'chargerId', 'targetId']) {
      if (out[k]) out[k] = remap(out[k]);
    }
    emit('log:append', out);
    await wait(18);
  }
  await wait(300);
  toast(`Imported ${data.log.length} events`);
}

// ── Account ────────────────────────────────────────────────────────────────
let authState = { signedIn: false };

function renderAccount() {
  const out  = document.getElementById('signed-out');
  const inEl = document.getElementById('signed-in');
  const na   = document.getElementById('auth-unavailable');
  const saved = document.getElementById('saved-battles');

  const configured = authState.signedIn || authState.enabled;
  na.classList.toggle('hidden', configured);
  out.classList.toggle('hidden', authState.signedIn || !authState.enabled);
  inEl.classList.toggle('hidden', !authState.signedIn);
  saved.classList.toggle('hidden', !authState.signedIn);

  if (authState.signedIn) {
    document.getElementById('account-email').textContent = authState.email ?? '';
    const pic = document.getElementById('account-pic');
    if (authState.picture) { pic.src = authState.picture; pic.classList.remove('hidden'); }
    else pic.classList.add('hidden');
    loadBattleList();
  } else if (authState.enabled) {
    mountGoogleButton(authState.clientId);
  }
}

let googleMounted = false;
function mountGoogleButton(clientId) {
  if (googleMounted || !clientId || !window.google?.accounts?.id) return;
  googleMounted = true;
  google.accounts.id.initialize({
    client_id: clientId,
    callback: async ({ credential }) => {
      const res = await fetch('/api/auth/google', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ credential }),
      });
      if (!res.ok) { setHomeError('Sign-in failed.'); return; }
      const { user } = await res.json();
      authState = { signedIn: true, enabled: true, ...user };
      renderAccount();
    },
  });
  google.accounts.id.renderButton(document.getElementById('google-btn'),
    { theme: 'filled_black', size: 'large', shape: 'pill', text: 'signin_with' });
}

async function loadBattleList() {
  const ul = document.getElementById('battle-list');
  ul.innerHTML = '';
  let battles = [];
  try {
    const res = await fetch('/api/battles', { credentials: 'same-origin' });
    if (!res.ok) return;
    ({ battles } = await res.json());
  } catch { return; }

  if (!battles.length) {
    const li = document.createElement('li');
    li.className = 'battle-empty';
    li.textContent = 'No saved battles yet.';
    ul.appendChild(li);
    return;
  }
  for (const b of battles) {
    const li = document.createElement('li');
    li.className = 'battle-item';
    const when = new Date(b.updated_at).toLocaleDateString();
    li.innerHTML = `
      <span class="battle-name">${esc(b.name || 'Untitled')}</span>
      <span class="battle-meta">${esc(b.side_a_name)} v ${esc(b.side_b_name)} · ${when}</span>`;
    li.addEventListener('click', () => { openSocket(); emit('battle:join', { token: b.token }); });
    ul.appendChild(li);
  }
}

async function signOut() {
  await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
  authState = { signedIn: false, enabled: authState.enabled, clientId: authState.clientId };
  googleMounted = false;
  document.getElementById('google-btn').innerHTML = '';
  renderAccount();
  renderDrawerAccount();
  toast('Signed out');
}

document.getElementById('btn-signout').addEventListener('click', signOut);

// Fetched up front so the home screen knows whether saving is even possible.
(async function initAccount() {
  try {
    const res = await fetch('/api/auth/me', { credentials: 'same-origin' });
    const { user, auth } = await res.json();
    authState = user
      ? { signedIn: true, enabled: true, ...user }
      : { signedIn: false, ...auth };
  } catch {
    authState = { signedIn: false, enabled: false };
  }
  renderAccount();
  // the GIS script may still be loading
  if (!authState.signedIn && authState.enabled) {
    setTimeout(() => mountGoogleButton(authState.clientId), 600);
  }
})();

// First visit: ask which ops room before anything else.
if (!Theme.hasChosenTheme()) showThemePicker();
renderThemeControls();

function renderSaveState(persisted) {
  const el = document.getElementById('save-state');
  el.textContent = persisted ? 'Saved' : 'Not saved';
  el.classList.toggle('is-saved', !!persisted);
  el.title = persisted
    ? 'This battle is stored to your account.'
    : 'Sign in before starting a battle to keep it.';
}

// ── Add-unit modal ─────────────────────────────────────────────────────────
const unitModal = document.getElementById('unit-modal');

document.getElementById('btn-add-unit').addEventListener('click', () => {
  document.getElementById('unit-name').value = '';
  document.getElementById('unit-kind').value = 'unit';
  document.getElementById('unit-side').value = cursor.side;
  document.getElementById('unit-strength').value = 10;
  syncUnitModalFields();
  unitModal.classList.remove('hidden');
  document.getElementById('unit-name').focus();
});

document.getElementById('unit-kind').addEventListener('change', syncUnitModalFields);
function syncUnitModalFields() {
  const kind = document.getElementById('unit-kind').value;
  document.getElementById('field-side').classList.toggle('hidden', kind !== 'unit');
  document.getElementById('field-strength').classList.toggle('hidden', kind !== 'unit');
}

document.getElementById('unit-cancel').addEventListener('click',
  () => unitModal.classList.add('hidden'));

document.getElementById('unit-ok').addEventListener('click', submitUnit);
document.getElementById('unit-name').addEventListener('keydown',
  (e) => { if (e.key === 'Enter') submitUnit(); });

function submitUnit() {
  const kind = document.getElementById('unit-kind').value;
  emit('unit:add', {
    name: document.getElementById('unit-name').value,
    kind,
    side: document.getElementById('unit-side').value,
    startingStrength: +document.getElementById('unit-strength').value,
  });
  unitModal.classList.add('hidden');
}

// ── Army list import ───────────────────────────────────────────────────────

const listModal = document.getElementById('list-modal');
let importSide = 'A';
let parsed = null;

document.getElementById('btn-import-list').addEventListener('click', () => {
  importSide = cursor.side;              // default to whoever's turn it is
  document.getElementById('list-text').value = '';
  document.getElementById('list-status').textContent = '';
  setParsed(null);
  renderImportSides();
  listModal.classList.remove('hidden');
  document.getElementById('list-text').focus();
});

function renderImportSides() {
  document.getElementById('import-side-a').textContent = sideName('A');
  document.getElementById('import-side-b').textContent = sideName('B');
  document.querySelectorAll('#import-side button').forEach(b =>
    b.classList.toggle('on', b.dataset.side === importSide));
}

document.querySelectorAll('#import-side button').forEach(b =>
  b.addEventListener('click', () => { importSide = b.dataset.side; renderImportSides(); }));

document.getElementById('list-cancel').addEventListener('click',
  () => listModal.classList.add('hidden'));

document.getElementById('btn-list-file').addEventListener('click',
  () => document.getElementById('list-file').click());

document.getElementById('list-file').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  const text = await file.text();
  document.getElementById('list-text').value = text;
  document.getElementById('list-status').textContent = file.name;
  reparse();
});

let parseTimer = null;
document.getElementById('list-text').addEventListener('input', () => {
  clearTimeout(parseTimer);
  parseTimer = setTimeout(reparse, 180);   // parse as you paste
});

function reparse() {
  const text = document.getElementById('list-text').value;
  setParsed(text.trim() ? ListParser.parseList(text) : null);
}

// Nothing is added until the preview is confirmed — an army list is a lot of
// units to undo one at a time if the parse went wrong.
function setParsed(result) {
  parsed = result;
  const box  = document.getElementById('list-preview');
  const ul   = document.getElementById('preview-list');
  const warn = document.getElementById('preview-warn');
  const confirm = document.getElementById('list-confirm');

  if (!result) {
    box.classList.add('hidden');
    confirm.disabled = true;
    confirm.textContent = 'Import';
    return;
  }

  box.classList.remove('hidden');
  document.getElementById('preview-format').textContent = result.formatLabel;

  if (!result.ok) {
    ul.innerHTML = `<li class="preview-empty">${esc(result.error)}</li>`;
    document.getElementById('preview-summary').textContent = 'Could not read this list';
    warn.classList.add('hidden');
    confirm.disabled = true;
    return;
  }

  const bits = [`${result.units.length} units`];
  if (result.totalPoints) bits.push(`${result.totalPoints} pts`);
  if (result.faction)     bits.push(result.faction);
  document.getElementById('preview-summary').textContent = bits.join(' · ');

  ul.innerHTML = result.units.map(u => `
    <li class="preview-item">
      <span class="pi-name">${esc(u.name)}</span>
      <span class="pi-models">${u.models > 1 ? u.models + ' models' : '1 model'}</span>
      <span class="pi-pts">${u.points || ''}</span>
    </li>`).join('');

  warn.classList.toggle('hidden', !result.warnings.length);
  warn.textContent = result.warnings.join(' ');

  confirm.disabled = false;
  confirm.textContent = `Import ${result.units.length} units`;
}

document.getElementById('list-confirm').addEventListener('click', () => {
  if (!parsed?.ok) return;
  for (const u of parsed.units) {
    emit('unit:add', {
      name: u.name,
      catalogName: u.catalogName,
      points: u.points,
      side: importSide,
      kind: 'unit',
      startingStrength: u.models,
    });
  }
  // Record the faction against the side if we found one and none is set.
  if (parsed.faction && !meta.sides[importSide]?.faction) {
    emit('meta:set', { sides: { [importSide]: { faction: parsed.faction } } });
  }
  listModal.classList.add('hidden');
  toast(`Imported ${parsed.units.length} units for ${sideName(importSide)}`);
});

// ── Log helpers ────────────────────────────────────────────────────────────
function appendEvent(ev) { emit('log:append', ev); }

document.getElementById('btn-undo').addEventListener('click', () => emit('log:undo'));

// ── Theme: first-run chooser + settings drawer ─────────────────────────────

// The canvas caches resolved tokens, so any theme or orientation change has
// to invalidate it and refit — otherwise the board keeps the old palette.
Theme.onThemeChange(() => {
  PAL = null;
  applyOrientation();
  if (!document.getElementById('screen-battle').classList.contains('hidden')) {
    resizeCanvas(); fitCamera();
  }
  renderThemeControls();
  if (roster.length || log.length) renderAll();
});

function showThemePicker() {
  const grid = document.getElementById('theme-grid');
  grid.innerHTML = '';
  for (const t of Theme.THEMES) {
    const card = document.createElement('button');
    card.className = 'theme-card';
    card.innerHTML = `
      <span class="tc-preview">${t.swatch.map(c =>
        `<span style="background:${c}"></span>`).join('')}</span>
      <span class="tc-body">
        <span class="tc-name">${esc(t.name)}</span>
        <span class="tc-era">${esc(t.era)}</span>
        <span class="tc-blurb">${esc(t.blurb)}</span>
      </span>`;
    // preview on hover so the choice is felt rather than guessed
    card.addEventListener('mouseenter', () => Theme.applyTheme(t.id, { persist: false }));
    card.addEventListener('click', () => {
      Theme.applyTheme(t.id);
      document.getElementById('theme-picker').classList.add('hidden');
    });
    grid.appendChild(card);
  }
  grid.addEventListener('mouseleave', () => Theme.applyTheme(Theme.currentTheme(), { persist: false }));
  document.getElementById('theme-picker').classList.remove('hidden');
}

function renderThemeControls() {
  const rows = document.getElementById('theme-rows');
  if (rows) {
    rows.innerHTML = '';
    for (const t of Theme.THEMES) {
      const b = document.createElement('button');
      b.className = 'theme-row' + (t.id === Theme.currentTheme() ? ' sel' : '');
      b.innerHTML = `
        <span class="sw">${t.swatch.map(c => `<span style="background:${c}"></span>`).join('')}</span>
        <span class="tx"><b>${esc(t.name)}</b><i>${esc(t.era)}</i></span>`;
      b.addEventListener('click', () => Theme.applyTheme(t.id));
      rows.appendChild(b);
    }
  }
  document.querySelectorAll('#orient-seg button').forEach(b =>
    b.classList.toggle('on', b.dataset.orient === Theme.boardOrientation()));
  renderDrawerAccount();
}

function renderDrawerAccount() {
  const el = document.getElementById('drawer-account');
  if (!el) return;
  if (authState.signedIn) {
    el.innerHTML = `
      <div class="acct-line">
        ${authState.picture ? `<img src="${esc(authState.picture)}" alt="" />` : ''}
        <span>${esc(authState.email ?? '')}</span>
      </div>`;
    const out = document.createElement('button');
    out.className = 'btn-ghost';
    out.style.width = '100%';
    out.textContent = 'Sign out';
    out.addEventListener('click', signOut);
    el.appendChild(out);
  } else if (authState.enabled) {
    el.innerHTML = `<p class="drawer-note" style="margin-top:0">
      Not signed in — battles are not being saved. Sign in from the home screen.</p>`;
  } else {
    el.innerHTML = `<p class="drawer-note" style="margin-top:0">
      Sign-in is not configured on this server, so battles cannot be saved.
      Use Export JSON to keep a copy.</p>`;
  }
}

document.querySelectorAll('.settings-open').forEach(b =>
  b.addEventListener('click', () => {
    renderThemeControls();
    const inBattle = !document.getElementById('screen-battle').classList.contains('hidden')
                  || !document.getElementById('screen-report').classList.contains('hidden');
    document.getElementById('drawer-export').classList.toggle('hidden', !inBattle);
    document.getElementById('drawer-leave').classList.toggle('hidden', !inBattle);
    document.getElementById('settings-drawer').classList.remove('hidden');
  }));

document.getElementById('settings-close').addEventListener('click', closeSettings);
document.getElementById('settings-drawer').addEventListener('click', (e) => {
  if (e.target.id === 'settings-drawer') closeSettings();   // click the scrim
});
function closeSettings() {
  document.getElementById('settings-drawer').classList.add('hidden');
}
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeSettings();
});

document.querySelectorAll('#orient-seg button').forEach(b =>
  b.addEventListener('click', () => Theme.setBoardOrientation(b.dataset.orient)));

document.getElementById('drawer-leave').addEventListener('click', () => location.reload());
document.getElementById('drawer-export').addEventListener('click',
  () => document.getElementById('btn-export-json').click());

// ── Toast ──────────────────────────────────────────────────────────────────
let toastTimer = null;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1800);
}

document.getElementById('token-badge').addEventListener('click', () => {
  if (!battleToken) return;
  navigator.clipboard.writeText(battleToken).catch(() => {});
  toast('Token copied');
});

document.getElementById('btn-leave').addEventListener('click', () => location.reload());

// ── Screens ────────────────────────────────────────────────────────────────
function show(screenId) {
  for (const id of ['screen-home', 'screen-battle', 'screen-report']) {
    document.getElementById(id).classList.toggle('hidden', id !== screenId);
  }
}

function showBattle() {
  show('screen-battle');
  resizeCanvas();
  fitCamera();
  renderAll();
  requestAnimationFrame(render);
}

function setHomeError(msg) {
  const el = document.getElementById('home-error');
  el.textContent = msg;
  el.classList.toggle('hidden', !msg);
}

// ── Home ───────────────────────────────────────────────────────────────────
document.getElementById('btn-start').addEventListener('click', () => {
  setHomeError('');
  openSocket();
  emit('battle:start', {});
});

document.getElementById('btn-show-join').addEventListener('click', () => {
  document.getElementById('join-form').classList.remove('hidden');
  document.getElementById('btn-show-join').classList.add('hidden');
  document.getElementById('join-token-input').focus();
});

document.getElementById('btn-join').addEventListener('click', doJoin);
document.getElementById('join-token-input').addEventListener('keydown',
  (e) => { if (e.key === 'Enter') doJoin(); });

function doJoin() {
  const token = document.getElementById('join-token-input').value.trim().toUpperCase();
  if (token.length !== 6) { setHomeError('Enter a 6-character token.'); return; }
  setHomeError('');
  openSocket();
  emit('battle:join', { token });
}

let socketOpened = false;
function openSocket() {
  connectSocket(location.origin);
  if (socketOpened) return;      // handlers survive; binding again would double-fire
  socketOpened = true;
  on('battle:state', handleBattleState);
  on('battle:error', ({ message }) => setHomeError(message));
  on('auth:state', (s) => {
    authState = s.signedIn ? { ...s, enabled: true } : { signedIn: false, ...s };
    renderAccount();
  });

  // A reconnect gives us a new socket id, which the server does not
  // associate with any battle. Re-join immediately or every subsequent
  // write is dropped while the UI still looks connected.
  onReconnect(() => { if (battleToken) emit('battle:join', { token: battleToken }); });

  onConnectionChange(ok => setConnection(ok ? 'live' : 'offline'));

  // Server-side backstop: it tells us when a write landed on a socket it
  // has no battle for. Re-join, then replay the write that was refused.
  on('battle:orphaned', ({ pending }) => {
    setConnection('recovering');
    if (!battleToken) return;
    if (pending) orphanQueue.push(pending);
    emit('battle:join', { token: battleToken });
  });

  on('battle:rejected', () => toast('That event was not accepted'));
}

// Writes refused while the socket had no battle, replayed after re-joining.
let orphanQueue = [];

function flushOrphanQueue() {
  if (!orphanQueue.length) return;
  const queued = orphanQueue;
  orphanQueue = [];
  for (const ev of queued) emit('log:append', ev);
  toast(`Reconnected — ${queued.length} event(s) resent`);
}

function setConnection(state) {
  const el = document.getElementById('save-state');
  if (!el) return;
  el.dataset.conn = state;
  if (state === 'offline')    el.textContent = 'Offline';
  else if (state === 'recovering') el.textContent = 'Reconnecting…';
  else renderSaveState(lastPersisted);
}

// ── Socket handlers ────────────────────────────────────────────────────────
function handleBattleState(state) {
  mySocketId  = state.yourId;
  battleToken = state.token;
  meta   = state.meta;
  roster = state.roster;
  log    = state.log;
  cursor = state.cursor;

  document.getElementById('topbar-token').textContent = battleToken;

  players.clear();
  for (const p of state.players) players.set(p.socketId, { username: p.username, color: p.color });

  lastPersisted = state.persisted;
  renderSaveState(state.persisted);
  renderPlayers();
  showBattle();
  wireBattleEvents();
  flushOrphanQueue();   // replay anything refused while we were orphaned
}

let lastPersisted = false;

let wired = false;
function wireBattleEvents() {
  if (wired) return;
  wired = true;

  on('lobby:playerJoined', ({ socketId, username, color }) => {
    players.set(socketId, { username, color });
    renderPlayers();
  });
  on('lobby:playerLeft', ({ socketId }) => {
    players.delete(socketId);
    for (const [id, holder] of locks) if (holder === socketId) locks.delete(id);
    renderPlayers();
  });
  on('player:renamed', ({ socketId, username }) => {
    const p = players.get(socketId);
    if (p) p.username = username;
    renderPlayers();
  });

  on('meta:updated', (m) => { meta = m; renderAll(); });

  on('unit:added', (u) => { roster.push(u); renderAll(); });
  on('unit:removed', ({ id }) => {
    roster = roster.filter(u => u.id !== id);
    if (sel.actorId  === id) sel.actorId  = null;
    if (sel.targetId === id) sel.targetId = null;
    renderAll();
  });

  on('log:appended', (ev) => { log.push(ev); renderAll(); });
  on('log:undone', ({ seq }) => { log = log.filter(e => e.seq !== seq); renderAll(); });

  on('battle:cursorSet', (c) => {
    cursor = c;
    sel.actorId = null; sel.targetId = null;
    renderAll();
  });

  on('unit:grabGranted', ({ id }) => {
    if (drag.pending !== id) return;
    const u = unitState.get(id);
    drag.active = true;
    drag.unitId = id;
    drag.preview = u ? { x: u.x, y: u.y } : null;
    locks.set(id, mySocketId);
  });
  on('unit:grabDenied', ({ id }) => { if (drag.pending === id) drag.pending = null; });
  on('unit:grabbed',  ({ id, socketId }) => locks.set(id, socketId));
  on('unit:released', ({ id }) => locks.delete(id));
  on('unit:dragged',  ({ id, x, y }) => {
    const u = unitState.get(id);
    if (u && drag.unitId !== id) { u.x = x; u.y = y; }
  });
}
