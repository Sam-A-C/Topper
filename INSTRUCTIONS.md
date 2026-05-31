# Topper — 2D Top-Down Tabletop Simulator

A real-time multiplayer tabletop simulator where players join a shared lobby and interact with objects on a virtual table together.

---

## Vision

Topper is a browser-based, 2D top-down virtual tabletop. Players join a shared lobby using a short session token, then see and interact with a shared canvas — moving objects (cards, tiles, and other pieces) in real time. Think of it as a lightweight, no-install alternative to Roll20 or Tabletop Simulator, built on the same stack as [Roller](https://github.com/Sam-A-C/Roller).

### Core design principle — one path, no solo/multiplayer split

Unlike Roller, which has **separate code paths** for solo and multiplayer, Topper has exactly one. **Every session is a real, server-backed lobby with a token from the moment it's created.** Solo play is simply a lobby with one player in it; "multiplayer" is just what happens when a second person joins using the token. There is no solo state store, no local-vs-server branching, and no "promote to multiplayer" transition.

Consequences of this principle (decided up front):
- **The backend must be running for any session, including solo.** There is no offline "just open the file" mode (that was a Roller property we are deliberately trading away for a single clean code path).
- **A shareable token is minted on Start, always.** Any solo game can become multiplayer the instant the token is shared — no extra step.

---

## Tech Stack

Same pattern as Roller — no build step for the frontend, minimal backend.

| Layer | Technology |
|---|---|
| Frontend | Vanilla JS, HTML, CSS (no framework, no bundler) |
| Backend | Node.js + Express + Socket.io |
| Real-time | Socket.io (WebSocket with fallback) |
| Session state | In-memory (ephemeral, no DB) |

---

## Visual Style

Inherit the Roller dark theme:

```css
:root {
  --bg:           #1a1a2e;
  --surface:      #16213e;
  --card:         #0f3460;
  --accent:       #e94560;
  --accent-hover: #c73652;
  --text:         #eaeaea;
  --text-muted:   #8892a4;
  --radius:       12px;
  --success:      #1a5c38;
}
```

- Dark navy base with red accent buttons
- Rounded cards, subtle borders
- Responsive layout — works on desktop; mobile is secondary
- Light mode optional (toggle via `<html class="light-mode">`)

---

## File Structure

```
Topper/
├── index.html          # Home screen + lobby join + canvas view
├── app.js              # All frontend logic
├── socket-client.js    # Socket.io connection + event wrappers
├── style.css           # All styles (CSS custom properties)
└── backend/
    ├── server.js           # Express + Socket.io event handlers
    ├── lobbyManager.js     # In-memory lobby/object state
    ├── package.json
    └── .env.example
```

---

## Screens

There are only **two screens total**: the Home screen and the Table view. The Table view is identical whether one or many players are present — the only visible difference is how many entries appear in the player list.

### Usernames

Usernames are **auto-generated** on join (e.g. `Player-A4`) so that Start is genuinely one click with no form. Players can **rename themselves later** from the Table view (click own entry in the player list → inline edit → broadcast the new name). No username field on the Home screen.

### No host concept

There is **deliberately no host/owner role that the user ever sees or considers.** Every player has identical capabilities — anyone can add, move, remove objects, or clear the table. When any player leaves (including the original creator), the lobby simply persists for whoever remains. The lobby is only destroyed when the **last** player leaves. Internally there is no `hostId` and no special-cased socket; the creator is just the first entry in `players`.

### 1. Home Screen
- Title + subtitle, centered card layout (same as Roller's home screen)
- Two actions only:
  - **Start** — creates a new server-backed lobby, mints a 6-char token, joins as the first player. Goes straight to the Table view.
  - **Join** — reveals a token input; joins the existing lobby and goes to the Table view.
- No username field on either action — usernames are auto-generated server-side (see "Usernames" above) and renamed later from the Table view.

### 2. Table View (the only gameplay screen)
- Full-viewport canvas area (the tabletop)
- Sidebar: player list with colors + the lobby token display (copy button) — always shown, even solo, so sharing is one click away
- Top bar: lobby token, leave button
- Objects rendered on canvas; each player has a distinct color
- **No solo/multiplayer distinction in the UI** — a one-player lobby and a five-player lobby use the exact same view and the exact same code.

---

## Architecture Decisions

These are foundational choices made during planning. They shape the protocol and render code, and are cheap now but expensive to retrofit — treat them as load-bearing.

### AD-1: World-space coordinates

All object positions are stored in **world space** — an abstract coordinate plane independent of the viewport or screen size. **The server only ever knows world coordinates.**

- Each client holds a `camera = { x, y, zoom }` and converts at render time via two helpers:
  - `worldToScreen(wx, wy)` → pixel position on the canvas
  - `screenToWorld(sx, sy)` → world position (used to interpret mouse events)
- In Phase 1 the camera is fixed at `{ x: 0, y: 0, zoom: 1 }`, so nothing visible changes.
- In Phase 2, pan/zoom is "let the user change the camera" — **zero server changes, zero protocol changes.**
- **Rule:** no raw screen pixels ever cross the network or get stored in an object. Mouse coordinates are converted to world space *immediately* on input.

### AD-2: First-grab-wins locking (server-authoritative)

The server owns the `locks` map and is the source of truth for who holds an object.

- On `object:grab`, the server checks the lock. If free, it grants the lock and **replies to the grabber** with `object:grabGranted`; otherwise replies `object:grabDenied`. It also broadcasts `object:grabbed` to everyone so they can render the lock indicator.
- A client **must not begin dragging** until it receives `object:grabGranted`. (Local prediction for *position* is fine — see AD-3 — but the grab itself is gated on the server's grant.)
- A denied grabber simply can't move the object until the holder releases it.
- On disconnect, the server releases any locks held by that socket and broadcasts `object:released`.

### AD-3: Local prediction + authoritative release

The dragging player gets instant feedback; consistency is reconciled on release.

- Once granted, the dragger moves the object **locally and immediately**, streaming `object:move` to the server, which relays `object:moved` to other clients. The dragger ignores echoes of its own moves.
- On mouse-up the dragger emits `object:release` carrying the **final world position**, which the server records authoritatively and broadcasts via `object:released`. This reconciles any dropped intermediate updates.
- Non-dragging clients may interpolate toward incoming positions for smoothness (Phase 2 polish, optional).

### AD-4: Objects as programming-style objects (base + per-type extension)

Everything on the table is an **Object** (the generic noun). The kind of object lives in a `type` field — `token`, `card`, `tile` are **type enum values**, treated like subclasses. Generic code (drag, lock, render, hit-test) operates only on the **base** and never branches on `type`; type-specific behaviour layers on top.

> **Terminology:** game pieces are always called **objects** in code and docs. The word **"token"** as a standalone noun is reserved for the **lobby code**; as an object kind it only ever appears as the enum value `type: "token"`.

```
Object (base — every object has these)
  id        string   // uuid v4, server-assigned
  type      "token" | "card" | "tile"
  x, y      number   // world coords (AD-1)
  z         number   // stacking order (AD-5 / bring-to-front)
  width     number
  height    number
  color     string   // hex
  label     string

// per-type extensions (Phase 1)
  token:  {}                 // small square; no extra fields yet
  card:   { faceUp: boolean } // tall rectangle; flippable
  tile:   {}                 // large square; no extra fields yet
```

- The base carries all generic behaviour. A new object kind in the future = add a `type` value + its default factory; the drag/lock/render pipeline is untouched.
- Per-type defaults (size, color, spawn shape) live in a single `OBJECT_DEFAULTS[type]` table on the server so `object:add` only needs `{ type, x, y, label }` and the server fills the rest.

### AD-5: Z-ordering (bring-to-front)

`z` defines draw and hit-test order (higher = on top).
- New objects spawn at `maxZ + 1`.
- Grabbing an object brings it to front (`maxZ + 1`) so the thing you're moving is always on top — the intuitive tabletop feel. The server assigns the new `z` and broadcasts it on `object:grabbed` (which carries `z`), so every client re-sorts.
- Hit-testing scans objects in descending `z` (topmost first) so a click grabs the visually-top object.

### AD-6: Measurement units — inches by default, `mm` opt-in, always report inches

The internal world unit is the **inch** (1 world unit = 1 inch — see AD-1). The whole app shares one measurement convention:
- **Input:** a number is interpreted as **inches** by default. A trailing `mm` suffix (e.g. `32mm`) means millimetres, converted via **1 inch = 25.4 mm** (`inches = mm / 25.4`).
- **Output:** measurements are **always displayed in inches** (e.g. the ruler readout, distances), regardless of how they were entered.
- Applies everywhere a length is entered or shown — ruler tool, base sizes, ranges, object dimensions. A single `parseLength(str)` → inches helper and a `formatLength(inches)` → string helper enforce this app-wide.
- Rationale: 40k movement/ranges are in inches but model **base sizes** are quoted in mm — this lets base sizes be typed naturally (`32mm`) while everything resolves to one internal unit.

---

## Core Features (Phase 1)

### Objects
- Schema and terminology defined in **AD-4** (base + per-type extension; "object" generic, "token" reserved for lobby code)
- Rendered as colored rectangles with a centered label — no images required for Phase 1
- Any player can grab any unlocked object (see AD-2)

### Drag & Drop
- Mouse down on an object → emit `object:grab`; **wait for `object:grabGranted`** before dragging (AD-2)
- Mouse move → convert pointer to world space, update locally, emit `object:move` with `{ id, x, y }` (world coords)
- Mouse up → emit `object:release` with the final `{ id, x, y }` (AD-3)
- Other clients update position on `object:moved`; locked objects show a 2px border in the holder's color

### Adding Objects
- Toolbar or right-click context menu: "Add Token", "Add Card", "Add Tile"
- Any player can clear the table (no host restriction)

### Real-time Sync
All object state lives on the server. New joiners receive full state snapshot.

---

## Backend Architecture

### lobbyManager.js

```
Lobby {
  token: string           // 6-char alphanumeric
  players: Map<socketId, { username, color }>  // first entry = creator, but not privileged
  objects: Map<id, Object>
  locks: Map<objectId, socketId>  // who is currently dragging what
}
```

- No `hostId` / no privileged player — every player is equal (see "No host concept")
- Lobbies persist as players come and go; auto-delete only when the **last** player leaves
- Object IDs: `uuid v4`
- Player colors: assigned from a fixed palette on join

### Socket Events

| Event | Direction | Payload |
|---|---|---|
| `lobby:start` | client→server | `{}` _(username auto-generated server-side)_ |
| `lobby:join` | client→server | `{ token }` |
| `lobby:state` | server→client | `{ players, objects, token, yourId }` |
| `lobby:playerJoined` | server→all | `{ socketId, username, color }` |
| `lobby:playerLeft` | server→all | `{ socketId }` |
| `player:rename` | client→server | `{ username }` |
| `player:renamed` | server→all | `{ socketId, username }` |
| `object:add` | client→server | `{ type, x, y, label }` _(world coords)_ |
| `object:added` | server→all | full object _(incl. server-assigned `id`, `z`)_ |
| `object:grab` | client→server | `{ id }` |
| `object:grabGranted` | server→grabber | `{ id }` — _grabber may now drag (AD-2)_ |
| `object:grabDenied` | server→grabber | `{ id, heldBy }` — _object already locked_ |
| `object:grabbed` | server→all | `{ id, socketId, z }` — _render lock indicator + bring-to-front (AD-5)_ |
| `object:move` | client→server | `{ id, x, y }` _(world coords)_ |
| `object:moved` | server→others | `{ id, x, y }` _(world coords; not echoed to sender)_ |
| `object:release` | client→server | `{ id, x, y }` _(final authoritative world pos, AD-3)_ |
| `object:released` | server→all | `{ id, x, y }` |
| `object:remove` | client→server | `{ id }` |
| `object:removed` | server→all | `{ id }` |
| `table:clear` | client→server | `{}` _(any player)_ |
| `table:cleared` | server→all | `{}` |

---

## Frontend Architecture

### app.js Structure

- **State** — flat module-scope: `mySocketId`, `myColor`, `objects` (Map), `locks` (Map), `camera` ({ x, y, zoom }, see AD-1), `dragging` (current drag state)
- **Home flow** — Start or Join → connect socket → emit `lobby:start`/`lobby:join` → receive `lobby:state` (stores `yourId`) → show table view
- **Render loop** — `requestAnimationFrame` loop redraws canvas each frame from `objects` Map, sorted by `z` (low→high)
- **Input** — mousedown/mousemove/mouseup; pointer converted to world space via `screenToWorld` *immediately*; hit-test objects in reverse `z` order (top first)
- **Grab gating** — mousedown emits `object:grab` and stores a "pending grab"; dragging only starts on `object:grabGranted` (ignore / cursor-feedback on `object:grabDenied`) — AD-2
- **Sidebar** — player list updates on `lobby:playerJoined` / `lobby:playerLeft` / `player:renamed`; clicking your own entry lets you rename (emits `player:rename`)

### Coordinate helpers (AD-1)

```js
function worldToScreen(wx, wy) {
  return { x: (wx - camera.x) * camera.zoom, y: (wy - camera.y) * camera.zoom };
}
function screenToWorld(sx, sy) {
  return { x: sx / camera.zoom + camera.x, y: sy / camera.zoom + camera.y };
}
```
Phase 1: `camera = { x: 0, y: 0, zoom: 1 }`, so these are effectively identity — but all code routes through them so Phase 2 pan/zoom is a no-op for everything else.

### Canvas Rendering

- Draw objects in ascending `z` order so higher-`z` objects land on top
- Each object: `worldToScreen` its corner, draw a filled rounded rectangle scaled by `camera.zoom`, label centered in white text
- Locked objects show a 2px border in the holder's color; my own grabbed object renders with a dashed border
- Phase 1 camera is fixed, but rendering already goes through the camera transform (AD-1)

### socket-client.js

Thin wrapper: exports `connectSocket(serverUrl)`, `emit(event, data)`, `on(event, cb)`. Mirrors the Roller pattern.

---

## Development

### Running locally

```bash
# Backend
cd backend
npm install
npm start        # listens on :3000

# Frontend
# open index.html directly in browser, or serve via backend static files
```

### Environment variables (`backend/.env`)

```
PORT=3000
CORS_ORIGIN=*
```

---

## Phase 2 Ideas (not in scope now)

- Pan & zoom the canvas (transform matrix)
- Image upload for objects (models/cards)
- Dice rolling integrated (pull from Roller)
- Fog of war / hidden objects per player
- Snap-to-grid toggle
- Persistent lobbies (SQLite or Redis)
- Mobile touch drag support
