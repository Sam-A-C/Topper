'use strict';

// ─────────────────────────────────────────────────────────────────────────
// Theme system.
//
// The three schemes differ in more than colour — typography, corner radius,
// letter-spacing and ornament all change — so every one of those is a token.
// Components read tokens and never name a scheme.
//
// CSS is the single source of truth: values live in [data-theme] blocks in
// style.css. The canvas cannot use custom properties directly, so it resolves
// them once per theme change via getComputedStyle rather than duplicating a
// palette here that could drift out of sync.
// ─────────────────────────────────────────────────────────────────────────

const THEMES = [
  {
    id: 'maproom',
    name: 'Map Room',
    era: '1943 – 1962',
    blurb: 'A plotting table in a bunker. Baize, buff and oxblood; stencilled and monospaced.',
    swatch: ['#2f4034', '#ddd6bd', '#c8503f', '#c9a227'],
  },
  {
    id: 'jointops',
    name: 'Joint Operations Centre',
    era: 'Present day',
    blurb: 'A modern command floor. Near-black slate, hairline rules, one cool accent.',
    swatch: ['#0a0e13', '#35c6d6', '#4a9eff', '#e5484d'],
  },
  {
    id: 'holotable',
    name: 'Holotable',
    era: 'Near future',
    blurb: 'A projected display. Translucent glass, lit edges and a faint scanline.',
    swatch: ['#03060d', '#22d3ee', '#e879f9', '#fde047'],
  },
];

const DEFAULT_THEME = 'jointops';

const STORE_THEME  = 'topper.theme';
const STORE_ORIENT = 'topper.boardOrientation';

// localStorage throws in some privacy modes; a theme is never worth a crash.
function readStore(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function writeStore(key, value) {
  try { localStorage.setItem(key, value); } catch { /* non-fatal */ }
}

function savedTheme()  { return readStore(STORE_THEME); }
function hasChosenTheme() { return THEMES.some(t => t.id === savedTheme()); }

function currentTheme() {
  return hasChosenTheme() ? savedTheme() : DEFAULT_THEME;
}

const listeners = [];
function onThemeChange(cb) { listeners.push(cb); }

function applyTheme(id, { persist = true } = {}) {
  const theme = THEMES.find(t => t.id === id) ? id : DEFAULT_THEME;
  document.documentElement.setAttribute('data-theme', theme);
  if (persist) writeStore(STORE_THEME, theme);
  palCache = null;                       // tokens changed — force a re-read
  for (const cb of listeners) cb(theme);
  return theme;
}

// ── Board orientation ────────────────────────────────────────────────────
// Landscape fits a widescreen monitor far better than the 44x60 portrait
// table. Positions already logged are plain world coordinates, so switching
// does not corrupt anything — a battle recorded in one orientation just sits
// oddly on the other.

function boardOrientation() {
  return readStore(STORE_ORIENT) === 'portrait' ? 'portrait' : 'landscape';
}
function setBoardOrientation(v) {
  writeStore(STORE_ORIENT, v === 'portrait' ? 'portrait' : 'landscape');
  for (const cb of listeners) cb(currentTheme());
}

// ── Canvas palette ───────────────────────────────────────────────────────
// Resolved from the live CSS tokens so the board can never disagree with the
// surrounding chrome.

let palCache = null;

function palette() {
  if (palCache) return palCache;
  const cs = getComputedStyle(document.documentElement);
  const v = (name, fallback = '#888') => {
    const got = cs.getPropertyValue(name).trim();
    return got || fallback;
  };
  palCache = {
    bg:            v('--bg', '#0a0e13'),
    text:          v('--text', '#dce6f0'),
    textMuted:     v('--text-muted', '#67788a'),
    accent:        v('--accent', '#35c6d6'),
    sideA:         v('--side-a', '#4a9eff'),
    sideB:         v('--side-b', '#e5484d'),

    felt:          v('--board-felt', '#0c1219'),
    feltEdge:      v('--board-edge', '#24333f'),
    grid:          v('--board-grid', 'rgba(120,160,190,.07)'),
    terrain:       v('--board-terrain', '#182430'),
    terrainEdge:   v('--board-terrain-edge', '#2c3e4e'),
    objective:     v('--board-objective', '#f5a524'),
    reserve:       v('--board-reserve', 'rgba(53,198,214,.035)'),
    reserveEdge:   v('--board-reserve-edge', 'rgba(53,198,214,.22)'),
    boardLabel:    v('--board-label', '#dce6f0'),

    fontUi:        v('--font-ui', 'sans-serif'),
    fontMono:      v('--font-mono', 'monospace'),
    labelWeight:   v('--board-label-weight', '600'),

    // token outline: themes that float their units set this to `none`
    tokenStroke:   v('--board-token-stroke', 'none'),
    glowBoard:     v('--board-glow', '0') === '1',

    effect: {
      whiff:    v('--effect-whiff', '#5a6b8c'),
      light:    v('--effect-light', '#81c784'),
      moderate: v('--effect-moderate', '#ffb74d'),
      heavy:    v('--effect-heavy', '#f4713f'),
      wiped:    v('--effect-wiped', '#e94560'),
    },
  };
  return palCache;
}

const Theme = {
  THEMES, DEFAULT_THEME,
  savedTheme, hasChosenTheme, currentTheme, applyTheme, onThemeChange,
  boardOrientation, setBoardOrientation,
  palette,
};

if (typeof window !== 'undefined') window.Theme = Theme;

// Apply immediately so there is no flash of the wrong theme before the rest
// of the app boots. First-time visitors get the default until they choose.
if (typeof document !== 'undefined') {
  document.documentElement.setAttribute('data-theme', currentTheme());
}
