'use strict';

// ── State ──────────────────────────────────────────────────────────────────
let mySocketId = null;
let myColor    = null;
let lobbyToken = null;

const objects  = new Map();   // id → object
const locks    = new Map();   // objectId → socketId (who is dragging)
const players  = new Map();   // socketId → { username, color }

// AD-1: fixed camera for Phase 1 — all code routes through helpers so Phase 2 is free
const camera = { x: 0, y: 0, zoom: 1 };

// Drag state
const drag = {
  active:    false,
  objectId:  null,
  pending:   null,   // objectId waiting for grabGranted
  offsetX:   0,      // world-space grab offset
  offsetY:   0,
};

// Context-menu state
const ctxMenu = {
  worldX: 0,
  worldY: 0,
  targetId: null,
};

// ── Canvas setup ───────────────────────────────────────────────────────────
const canvas = document.getElementById('table-canvas');
const ctx    = canvas.getContext('2d');

function resizeCanvas() {
  const wrap = document.getElementById('canvas-wrap');
  canvas.width  = wrap.clientWidth;
  canvas.height = wrap.clientHeight;
}
window.addEventListener('resize', resizeCanvas);

// ── Coordinate helpers (AD-1) ──────────────────────────────────────────────
function worldToScreen(wx, wy) {
  return { x: (wx - camera.x) * camera.zoom, y: (wy - camera.y) * camera.zoom };
}
function screenToWorld(sx, sy) {
  return { x: sx / camera.zoom + camera.x, y: sy / camera.zoom + camera.y };
}

// pixels per world-unit (inch) — tie to a readable scale
const PX_PER_INCH = 60; // 60px = 1 inch at zoom 1

function worldToScreenScaled(wx, wy) {
  return {
    x: (wx - camera.x) * camera.zoom * PX_PER_INCH,
    y: (wy - camera.y) * camera.zoom * PX_PER_INCH,
  };
}
function screenToWorldScaled(sx, sy) {
  return {
    x: sx / (camera.zoom * PX_PER_INCH) + camera.x,
    y: sy / (camera.zoom * PX_PER_INCH) + camera.y,
  };
}

// ── Board layout constants ─────────────────────────────────────────────────
const BOARD = { x: 0, y: 0, w: 44, h: 60 };
const STAGING_DEPTH = 14; // inches
const STAGING_A = { x: 0, y: -STAGING_DEPTH, w: 44, h: STAGING_DEPTH, label: 'Player A — Staging' };
const STAGING_B = { x: 0, y: 60,             w: 44, h: STAGING_DEPTH, label: 'Player B — Staging' };

// ── Render loop ────────────────────────────────────────────────────────────
function render() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // staging area A (top)
  drawStagingArea(STAGING_A);

  // play area (44"×60" — standard 40k matched play)
  const tl = worldToScreenScaled(BOARD.x, BOARD.y);
  const br = worldToScreenScaled(BOARD.x + BOARD.w, BOARD.y + BOARD.h);
  ctx.fillStyle = 'rgba(15, 52, 96, 0.18)';
  ctx.fillRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
  ctx.strokeStyle = '#3a5a8c';
  ctx.lineWidth   = 1.5;
  ctx.setLineDash([]);
  ctx.strokeRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);

  // staging area B (bottom)
  drawStagingArea(STAGING_B);

  // sort by z ascending
  const sorted = [...objects.values()].sort((a, b) => a.z - b.z);

  for (const obj of sorted) {
    const { x: sx, y: sy } = worldToScreenScaled(obj.x, obj.y);
    const sw = obj.width  * camera.zoom * PX_PER_INCH;
    const sh = obj.height * camera.zoom * PX_PER_INCH;

    const lockedBy = locks.get(obj.id);
    const isMyDrag = drag.active && drag.objectId === obj.id;

    // shadow for dragged objects
    if (lockedBy) {
      ctx.shadowColor = players.get(lockedBy)?.color ?? '#fff';
      ctx.shadowBlur  = 12;
    }

    // fill
    ctx.fillStyle = obj.color;
    if (obj.type === 'token') {
      // circles for tokens (model bases)
      ctx.beginPath();
      ctx.arc(sx + sw / 2, sy + sh / 2, sw / 2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      roundRect(ctx, sx, sy, sw, sh, 6 * camera.zoom);
      ctx.fill();
    }

    ctx.shadowBlur = 0;

    // border
    if (lockedBy) {
      const holderColor = players.get(lockedBy)?.color ?? '#fff';
      ctx.strokeStyle = holderColor;
      ctx.lineWidth   = 2;
      if (isMyDrag) {
        ctx.setLineDash([5, 3]);
      }
      if (obj.type === 'token') {
        ctx.beginPath();
        ctx.arc(sx + sw / 2, sy + sh / 2, sw / 2, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        roundRect(ctx, sx, sy, sw, sh, 6 * camera.zoom);
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }

    // label
    if (obj.label) {
      ctx.fillStyle    = '#fff';
      ctx.font         = `bold ${Math.max(10, 12 * camera.zoom)}px 'Segoe UI', sans-serif`;
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(obj.label, sx + sw / 2, sy + sh / 2, sw - 4);
    }
  }

  requestAnimationFrame(render);
}

function drawStagingArea(s) {
  const tl = worldToScreenScaled(s.x, s.y);
  const br = worldToScreenScaled(s.x + s.w, s.y + s.h);
  const sw = br.x - tl.x;
  const sh = br.y - tl.y;

  ctx.fillStyle = 'rgba(233, 69, 96, 0.06)';
  ctx.fillRect(tl.x, tl.y, sw, sh);

  ctx.strokeStyle = 'rgba(233, 69, 96, 0.3)';
  ctx.lineWidth   = 1;
  ctx.setLineDash([4, 4]);
  ctx.strokeRect(tl.x, tl.y, sw, sh);
  ctx.setLineDash([]);

  const fontSize = Math.max(9, 11 * camera.zoom);
  ctx.fillStyle    = 'rgba(233, 69, 96, 0.45)';
  ctx.font         = `600 ${fontSize}px 'Segoe UI', sans-serif`;
  ctx.textAlign    = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(s.label, tl.x + sw / 2, tl.y + sh / 2);
}

function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.lineTo(x + w - r, y);
  c.arcTo(x + w, y, x + w, y + r, r);
  c.lineTo(x + w, y + h - r);
  c.arcTo(x + w, y + h, x + w - r, y + h, r);
  c.lineTo(x + r, y + h);
  c.arcTo(x, y + h, x, y + h - r, r);
  c.lineTo(x, y + r);
  c.arcTo(x, y, x + r, y, r);
  c.closePath();
}

// ── Hit-testing ────────────────────────────────────────────────────────────
function hitTest(worldX, worldY) {
  const sorted = [...objects.values()].sort((a, b) => b.z - a.z); // top first
  for (const obj of sorted) {
    if (obj.type === 'token') {
      const cx = obj.x + obj.width  / 2;
      const cy = obj.y + obj.height / 2;
      const r  = obj.width / 2;
      const dx = worldX - cx;
      const dy = worldY - cy;
      if (dx * dx + dy * dy <= r * r) return obj;
    } else {
      if (worldX >= obj.x && worldX <= obj.x + obj.width &&
          worldY >= obj.y && worldY <= obj.y + obj.height) return obj;
    }
  }
  return null;
}

// ── Input ──────────────────────────────────────────────────────────────────
canvas.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  hideContextMenu();
  const { x: wx, y: wy } = screenToWorldScaled(e.offsetX, e.offsetY);
  const obj = hitTest(wx, wy);
  if (!obj) return;

  drag.pending  = obj.id;
  drag.offsetX  = wx - obj.x;
  drag.offsetY  = wy - obj.y;
  emit('object:grab', { id: obj.id });
});

canvas.addEventListener('mousemove', (e) => {
  if (!drag.active) return;
  const { x: wx, y: wy } = screenToWorldScaled(e.offsetX, e.offsetY);
  const obj = objects.get(drag.objectId);
  if (!obj) return;
  obj.x = wx - drag.offsetX;
  obj.y = wy - drag.offsetY;
  emit('object:move', { id: obj.id, x: obj.x, y: obj.y });
});

canvas.addEventListener('mouseup', (e) => {
  if (!drag.active) return;
  const { x: wx, y: wy } = screenToWorldScaled(e.offsetX, e.offsetY);
  const obj = objects.get(drag.objectId);
  if (obj) {
    obj.x = wx - drag.offsetX;
    obj.y = wy - drag.offsetY;
    emit('object:release', { id: obj.id, x: obj.x, y: obj.y });
  }
  drag.active   = false;
  drag.objectId = null;
  drag.pending  = null;
});

// cancel drag if mouse leaves canvas
canvas.addEventListener('mouseleave', (e) => {
  if (drag.active) {
    const obj = objects.get(drag.objectId);
    if (obj) emit('object:release', { id: obj.id, x: obj.x, y: obj.y });
    drag.active   = false;
    drag.objectId = null;
    drag.pending  = null;
  }
});

// right-click context menu
canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const { x: wx, y: wy } = screenToWorldScaled(e.offsetX, e.offsetY);
  ctxMenu.worldX   = wx;
  ctxMenu.worldY   = wy;
  ctxMenu.targetId = hitTest(wx, wy)?.id ?? null;

  const menu = document.getElementById('context-menu');
  const removeItem = document.getElementById('ctx-remove');
  removeItem.classList.toggle('hidden', ctxMenu.targetId === null);

  menu.style.left = e.clientX + 'px';
  menu.style.top  = e.clientY + 'px';
  menu.classList.remove('hidden');
});

document.getElementById('context-menu').addEventListener('click', (e) => {
  const action = e.target.dataset.action;
  if (!action) return;
  hideContextMenu();
  if (action === 'remove-object' && ctxMenu.targetId) {
    emit('object:remove', { id: ctxMenu.targetId });
    return;
  }
  const typeMap = { 'add-token': 'token', 'add-card': 'card', 'add-tile': 'tile' };
  const type = typeMap[action];
  if (type) {
    const wx = ctxMenu.worldX, wy = ctxMenu.worldY;
    promptLabel()
      .then(label => emit('object:add', { type, x: wx, y: wy, label }))
      .catch(() => {});
  }
});

window.addEventListener('click', hideContextMenu);

function hideContextMenu() {
  document.getElementById('context-menu').classList.add('hidden');
}

// ── Toolbar buttons ────────────────────────────────────────────────────────
// Returns a Promise<string> — resolves with label (may be empty) or rejects on cancel.
function promptLabel() {
  return new Promise((resolve, reject) => {
    const modal  = document.getElementById('label-modal');
    const input  = document.getElementById('label-input');
    const okBtn  = document.getElementById('label-ok');
    const canBtn = document.getElementById('label-cancel');

    input.value = '';
    modal.classList.remove('hidden');
    input.focus();

    function commit() {
      cleanup();
      resolve(input.value.trim());
    }
    function cancel() {
      cleanup();
      reject();
    }
    function cleanup() {
      modal.classList.add('hidden');
      okBtn.removeEventListener('click', commit);
      canBtn.removeEventListener('click', cancel);
      input.removeEventListener('keydown', onKey);
    }
    function onKey(e) {
      if (e.key === 'Enter')  commit();
      if (e.key === 'Escape') cancel();
    }

    okBtn.addEventListener('click', commit);
    canBtn.addEventListener('click', cancel);
    input.addEventListener('keydown', onKey);
  });
}

function spawnAtCenter(type) {
  const { x: wx, y: wy } = screenToWorldScaled(canvas.width / 2, canvas.height / 2);
  promptLabel()
    .then(label => emit('object:add', { type, x: wx, y: wy, label }))
    .catch(() => {});
}

document.getElementById('btn-add-token').addEventListener('click', () => spawnAtCenter('token'));
document.getElementById('btn-add-card').addEventListener('click',  () => spawnAtCenter('card'));
document.getElementById('btn-add-tile').addEventListener('click',  () => spawnAtCenter('tile'));
document.getElementById('btn-clear-table').addEventListener('click', () => {
  if (confirm('Clear the table? This removes all objects for everyone.')) {
    emit('table:clear', {});
  }
});

// ── Sidebar ────────────────────────────────────────────────────────────────
function renderPlayerList() {
  const ul = document.getElementById('player-list');
  ul.innerHTML = '';
  for (const [sid, p] of players) {
    const li   = document.createElement('li');
    const isMe = sid === mySocketId;
    if (isMe) li.classList.add('is-me');

    const dot = document.createElement('span');
    dot.className = 'player-dot';
    dot.style.background = p.color;

    const name = document.createElement('span');
    name.className = 'player-name';
    name.textContent = p.username + (isMe ? ' (you)' : '');

    li.appendChild(dot);
    li.appendChild(name);

    if (isMe) {
      li.addEventListener('click', () => startRename(li, name, sid));
    }

    ul.appendChild(li);
  }
}

function startRename(li, nameSpan, sid) {
  if (li.querySelector('.player-name-input')) return;
  const input = document.createElement('input');
  input.className = 'player-name-input';
  input.value = players.get(sid)?.username ?? '';
  li.replaceChild(input, nameSpan);
  input.focus();
  input.select();

  function commit() {
    const val = input.value.trim();
    if (val) emit('player:rename', { username: val });
    li.replaceChild(nameSpan, input);
  }
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter')  { input.blur(); }
    if (e.key === 'Escape') { li.replaceChild(nameSpan, input); }
  });
}

// ── Token copy ─────────────────────────────────────────────────────────────
document.getElementById('token-badge').addEventListener('click', () => {
  if (!lobbyToken) return;
  navigator.clipboard.writeText(lobbyToken).catch(() => {});
  const toast = document.getElementById('copy-toast');
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 1800);
});

// ── Leave ──────────────────────────────────────────────────────────────────
document.getElementById('btn-leave').addEventListener('click', () => {
  location.reload();
});

// ── Screen transitions ─────────────────────────────────────────────────────
function centerCameraOnBoard() {
  // fit the full area: both staging zones + play area
  const totalW = BOARD.w;
  const totalH = BOARD.h + STAGING_DEPTH * 2;
  const originY = -STAGING_DEPTH; // world top of the full area

  const margin = 32;
  const zoomW = (canvas.width  - margin * 2) / (totalW * PX_PER_INCH);
  const zoomH = (canvas.height - margin * 2) / (totalH * PX_PER_INCH);
  camera.zoom = Math.min(zoomW, zoomH);

  // center on the midpoint of the full area
  const centerWX = BOARD.w / 2;
  const centerWY = originY + totalH / 2;
  camera.x = centerWX - canvas.width  / 2 / (camera.zoom * PX_PER_INCH);
  camera.y = centerWY - canvas.height / 2 / (camera.zoom * PX_PER_INCH);
}

function showTable() {
  document.getElementById('screen-home').classList.add('hidden');
  document.getElementById('screen-table').classList.remove('hidden');
  resizeCanvas();
  centerCameraOnBoard();
  requestAnimationFrame(render);
}

function setHomeError(msg) {
  const el = document.getElementById('home-error');
  el.textContent = msg;
  el.classList.toggle('hidden', !msg);
}

// ── Home screen buttons ────────────────────────────────────────────────────
document.getElementById('btn-start').addEventListener('click', () => {
  setHomeError('');
  connectSocket(location.origin);
  on('lobby:state',  handleLobbyState);
  on('lobby:error',  ({ message }) => setHomeError(message));
  emit('lobby:start', {});
});

document.getElementById('btn-show-join').addEventListener('click', () => {
  document.getElementById('join-form').classList.remove('hidden');
  document.getElementById('btn-show-join').classList.add('hidden');
  document.getElementById('join-token-input').focus();
});

document.getElementById('btn-join').addEventListener('click', doJoin);
document.getElementById('join-token-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doJoin();
});

function doJoin() {
  const token = document.getElementById('join-token-input').value.trim().toUpperCase();
  if (token.length !== 6) { setHomeError('Enter a 6-character token.'); return; }
  setHomeError('');
  connectSocket(location.origin);
  on('lobby:state',  handleLobbyState);
  on('lobby:error',  ({ message }) => setHomeError(message));
  emit('lobby:join', { token });
}

// ── Socket event handlers ──────────────────────────────────────────────────
function handleLobbyState(state) {
  mySocketId = state.yourId;
  lobbyToken = state.token;

  document.getElementById('topbar-token').textContent = lobbyToken;

  players.clear();
  for (const p of state.players) {
    players.set(p.socketId, { username: p.username, color: p.color });
    if (p.socketId === mySocketId) myColor = p.color;
  }

  objects.clear();
  for (const obj of state.objects) objects.set(obj.id, obj);

  renderPlayerList();
  showTable();
  wireTableEvents();
}

let tableEventsWired = false;
function wireTableEvents() {
  if (tableEventsWired) return;
  tableEventsWired = true;

  on('lobby:playerJoined', ({ socketId, username, color }) => {
    players.set(socketId, { username, color });
    renderPlayerList();
  });

  on('lobby:playerLeft', ({ socketId }) => {
    players.delete(socketId);
    // release any locks that player held
    for (const [objId, holder] of locks) {
      if (holder === socketId) locks.delete(objId);
    }
    renderPlayerList();
  });

  on('player:renamed', ({ socketId, username }) => {
    const p = players.get(socketId);
    if (p) p.username = username;
    renderPlayerList();
  });

  // objects
  on('object:added', (obj) => { objects.set(obj.id, obj); });

  on('object:grabGranted', ({ id }) => {
    if (drag.pending !== id) return;
    drag.active   = true;
    drag.objectId = id;
    locks.set(id, mySocketId);
  });

  on('object:grabDenied', ({ id }) => {
    if (drag.pending === id) drag.pending = null;
  });

  on('object:grabbed', ({ id, socketId, z }) => {
    locks.set(id, socketId);
    const obj = objects.get(id);
    if (obj) obj.z = z;
  });

  on('object:moved', ({ id, x, y }) => {
    const obj = objects.get(id);
    if (obj) { obj.x = x; obj.y = y; }
  });

  on('object:released', ({ id, x, y }) => {
    locks.delete(id);
    const obj = objects.get(id);
    if (obj) { obj.x = x; obj.y = y; }
  });

  on('object:removed', ({ id }) => {
    objects.delete(id);
    locks.delete(id);
  });

  on('table:cleared', () => {
    objects.clear();
    locks.clear();
  });
}
