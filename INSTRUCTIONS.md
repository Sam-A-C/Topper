# Topper — 40k Battle Recorder

Log a game of Warhammer 40,000 as it happens, then get an after-action report out the other end: a turn-by-turn narrative, a board you can scrub through, and a short replay video.

---

## What this is (and isn't)

Topper records a battle. It does **not** run one.

- It is **not** a virtual tabletop — you are playing on a real table (or someone else's), and Topper sits alongside capturing what happened.
- It is **not** a rules engine. It knows the *shape* of a 40k turn (the five phases) and nothing else. No weapon profiles, no dice, no wound tracking, no legality checks.
- Granularity is deliberately **coarse**. Per phase you record the broad strokes: who shot whom and roughly how much it hurt. Never individual dice.

The output is the point. Everything in the app exists to make the report good.

### One token per unit

A unit is a single marker, not a pile of models. You drag one token per unit around a board. Model counts exist only as a rough strength number that depletes as the unit takes hits.

---

## Tech Stack

No build step, minimal backend.

| Layer | Technology |
|---|---|
| Frontend | Vanilla JS, HTML, CSS (no framework, no bundler) |
| Backend | Node.js + Express + Socket.io |
| Real-time | Socket.io (WebSocket with fallback) |
| Battle state | In-memory (ephemeral, reclaimed after 6h idle) |

---

## Visual Style

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

Dark navy base, red accent. Side A renders red, side B renders blue.

---

## File Structure

```
Topper/
├── index.html          # Home / Battle / Report screens
├── app.js              # UI, canvas, input, sockets, report, replay
├── battle.js           # Pure fold + narrative logic (no DOM, no sockets)
├── socket-client.js    # Socket.io wrapper
├── style.css           # All styles
└── backend/
    ├── server.js           # Express + Socket.io handlers
    ├── lobbyManager.js     # In-memory battle state
    ├── package.json
    └── .env.example
```

`battle.js` is deliberately dependency-free so the exported report can inline it verbatim.

---

## Architecture Decisions

### AD-1: World-space coordinates

Positions are stored in **world space**, 1 unit = 1 inch. The server only ever sees world coordinates. Each client holds `camera = { x, y, zoom }` and converts at render time. No screen pixel ever crosses the network.

### AD-2: First-grab-wins locking

The server owns the `locks` map. `unit:grab` is granted or denied; a client must not drag until granted. Applies only to movement-phase dragging.

### AD-3: Local prediction

The dragging client moves its token locally and immediately, streaming `unit:drag` for others to preview. The authoritative change is the `move` event appended on release — see AD-7.

### AD-4: Roster entries as base + kind

Everything on the board is a roster entry with a `kind`: `unit`, `terrain`, or `objective`. Generic code (drag, render, hit-test) operates on the base and never branches on kind; per-kind defaults live in one `UNIT_DEFAULTS` table on the server.

```
UnitDef
  id, name, side ('A'|'B'|null), kind, startingStrength, size, color
```

### AD-5: Draw order

Units draw and hit-test above objectives, which draw above terrain, so clicking a unit standing on a ruin grabs the unit.

### AD-6: Inches everywhere

The world unit is the inch. Distances in the report are always shown in inches.

### AD-7: The log is the source of truth ★

The load-bearing decision. A battle is an **append-only list of events**; board state at any moment is derived by folding that list:

```
boardStateAt(seq) = fold(log.filter(e => e.seq <= seq))
```

Unit positions and strengths are a **derived cache, never authoritative**. No feature writes board state directly — everything appends an event. This single choice provides timeline scrubbing, replay animation, video export, undo, and report generation from one mechanism.

The server assigns `id` and `seq` and stamps each event with the current cursor, so ordering is authoritative and clients cannot disagree about when something happened.

#### Event types

Every event carries `{ id, seq, ts, round, side, phase, type }` plus:

| type | fields |
|---|---|
| `deploy` | `unitId, x, y` |
| `move` | `unitId, from{x,y}, to{x,y}, moveType` |
| `shoot` | `shooterId, targetId, effect` |
| `fight` | `attackerId, targetId, effect` |
| `charge` | `chargerId, targetId, success` |
| `battleshock` | `unitId, passed` |
| `score` | `side, vp, kind, label` |
| `cp` | `side, delta, reason` |
| `destroy` | `unitId` |
| `note` | `text` |

`moveType` ∈ `stationary | normal | advance | fallback | reserves`.

#### The effect scale

The whole "roughly how effective" mechanic is one 5-point enum:

| effect | narrative | strength cost |
|---|---|---|
| `whiff` | to no effect | 0% |
| `light` | for light damage | 10% |
| `moderate` | for moderate damage | 33% |
| `heavy` | for heavy damage | 66% |
| `wiped` | wiping it out | 100% |

Attrition is **advisory** — it drives how depleted a token looks and nothing else. It is broad strokes, not bookkeeping.

### AD-8: Battles outlive their connections

The log is the deliverable, so an empty battle is not destroyed on disconnect. It is marked and reclaimed only after 6 hours idle, and any rejoin cancels the timer. A dropped connection or a page reload must never take the record with it.

---

## The cursor

`round 1..N` × `side A|B` × `phase command → movement → shooting → charge → fight`. Matches the 11th edition turn sequence. Advancing past Fight rolls to the next side; past side B's Fight rolls to the next round. The cursor is shared — everyone logging sees the same phase.

---

## Screens

### 1. Home
**New Battle** mints a 6-char token; **Join** enters an existing one.

### 2. Battle (the logging cockpit)
- Top bar: token, phase stepper, Report / Leave
- Phase rail: the five phases, click to jump
- Canvas: board (44"×60") with a Reserves strip per side
- Sidebar: VP/CP per side, roster, this phase's log, who's recording
- Bottom: **phase-contextual entry bar**

Undeployed units sit in their side's Reserves strip — drag one onto the board and it deploys. No separate deployment UI.

#### Entry bar by phase

| Phase | Controls |
|---|---|
| Command | `[Unit ▾]` → Passed / Failed · VP `+1..+5` · CP −1/+1 |
| Movement | Drag on the board; move-type chips pick how it moved |
| Shooting | `[Shooter ▾] [Target ▾]` → effect chips |
| Charge | `[Charger ▾] [Target ▾]` → Made it / Failed |
| Fight | `[Attacker ▾] [Target ▾]` → effect chips |

Clicking tokens on the canvas fills the pickers — own side sets the actor, enemy sets the target — so most events are two or three clicks. Dropdowns filter to living units on the correct side automatically.

### 3. Report
Turn-by-turn narrative grouped round → side → phase, final score, casualties, an effectiveness table, plus **Replay**, **Export video** (`.webm` via `MediaRecorder`), and **Export JSON**.

---

## Socket Events

| Event | Direction | Payload |
|---|---|---|
| `battle:start` | c→s | `{}` |
| `battle:join` | c→s | `{ token }` |
| `battle:state` | s→c | `{ token, yourId, meta, players, roster, log, cursor }` |
| `battle:error` | s→c | `{ message }` |
| `battle:setCursor` / `battle:stepCursor` | c→s | `{ round, side, phase }` / `{ dir }` |
| `battle:cursorSet` | s→all | `{ round, side, phase }` |
| `meta:set` / `meta:updated` | c→s / s→all | `{ name, date, mission, sides }` |
| `unit:add` / `unit:added` | c→s / s→all | UnitDef |
| `unit:remove` / `unit:removed` | c→s / s→all | `{ id }` |
| `log:append` / `log:appended` | c→s / s→all | event |
| `log:undo` / `log:undone` | c→s / s→all | `{}` / `{ seq }` |
| `unit:grab` | c→s | `{ id }` |
| `unit:grabGranted` / `unit:grabDenied` | s→grabber | `{ id }` / `{ id, heldBy }` |
| `unit:grabbed` / `unit:released` | s→all | `{ id, socketId }` / `{ id }` |
| `unit:drag` / `unit:dragged` | c→s / s→others | `{ id, x, y }` |
| `lobby:playerJoined` / `lobby:playerLeft` | s→all | `{ socketId, … }` |
| `player:rename` / `player:renamed` | c→s / s→all | `{ username }` |

---

## Accounts and persistence

Both are **optional**. With neither configured Topper records battles in memory exactly as before — you just can't save them or sign in. The app never has two code paths for this: writes go to the database when one exists and no-op when it doesn't.

- **Signed out** — battles live in memory and are reclaimed once idle (AD-8).
- **Signed in** — battles are written to Postgres as they happen and appear under "Your battles" on the home screen. Rejoining by token rehydrates from storage, resuming at the phase you left off.

Sign-in is Google only. The browser gets an ID token from Google Identity Services, the server verifies it against Google's keys and issues its own JWT session cookie. No passwords are ever handled.

### Setting it up

**1. Postgres.** Any provider — set `DATABASE_URL`. On Render, add a Postgres instance and use its internal connection string. The schema is created automatically on boot.

**2. Google OAuth client.** At [console.cloud.google.com/apis/credentials](https://console.cloud.google.com/apis/credentials) create an *OAuth 2.0 Client ID* of type **Web application**, add your origin (e.g. `https://topper-g651.onrender.com`, plus `http://localhost:3000` for local work) under **Authorised JavaScript origins**, and set the resulting client ID as `GOOGLE_CLIENT_ID`.

**3. Session secret.** Any long random string as `SESSION_SECRET`.

The server logs exactly which of these are missing on boot.

## Development

```bash
cd backend
npm install
npm start        # listens on :3000, also serves the frontend
```

```bash
npm test         # schema regression check, no database required
```

`backend/.env` — see `.env.example`:
```
PORT=3000
CORS_ORIGIN=*
DATABASE_URL=          # optional; without it, memory only
GOOGLE_CLIENT_ID=      # optional; requires DATABASE_URL
SESSION_SECRET=
```

## Data model and analytics

Stored battles are shaped for cross-game querying — events are typed rows and units resolve to a shared catalogue so the same unit aggregates across battles. See **[ANALYTICS.md](ANALYTICS.md)** for the schema rationale and worked queries.

Battles also export to versioned JSON (`schema: "topper.battle"`) and import back through the home screen, which round-trips meta, roster and the full event log.

---

## Not in scope

Weapon profiles, dice resolution, enforced wound tracking, army list building, turn/phase enforcement, line of sight — anything that requires encoding the rulebook. Topper records; the humans play.
