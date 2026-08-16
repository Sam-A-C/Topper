'use strict';

// ─────────────────────────────────────────────────────────────────────────
// Army list import.
//
// Pure parsing — no DOM, no sockets — so it can be unit-tested against the
// sample lists directly.
//
// Every builder emits a different shape, and the model count is the awkward
// part: some formats state it before the unit name, some inside a bullet,
// and GW's puts weapon counts in bullets that look identical to model counts.
// Each parser therefore keys off that format's own structural signal rather
// than trying to find one regex that fits all of them.
//
// Two names come out of every unit:
//   name        what the player sees on the board ("Reserve Lictor")
//   catalogName the datasheet ("Lictor") — what cross-battle analytics
//               groups on, so nicknames and duplicate suffixes do not split
//               the same unit into separate buckets.
// ─────────────────────────────────────────────────────────────────────────

const POINTS = String.raw`\((\d+)\s*(?:points?|pts?)\)`;

function detectFormat(text) {
  if (/^\+{5,}/m.test(text) && /FACTION KEYWORD:/i.test(text)) return 'wtc';
  if (/Created with WarOrgan/i.test(text) || /^Battle Size:/mi.test(text)) return 'warorgan';
  if (/^(ATTACHED UNITS|OTHER DATASHEETS|CHARACTER)\s*$/mi.test(text)) return 'gw';
  return 'generic';
}

const FORMAT_LABEL = {
  wtc:      'WTC',
  warorgan: 'WarOrgan',
  gw:       'Games Workshop app',
  generic:  'Unrecognised (best effort)',
};

// ── shared helpers ───────────────────────────────────────────────────────

const SKIP = /^(?:\+|Enhancement:|Categories:|Created with|Battle Size:|Detachments?:|Force Disposition:|Exported|Total)/i;

function cleanName(raw) {
  return String(raw)
    .replace(/^Char\d+:\s*/i, '')      // WTC character prefix
    .replace(/\s+/g, ' ')
    .trim();
}

// "Lictor [Reserve Lictor]" → datasheet "Lictor", alias "Reserve Lictor"
function splitAlias(name) {
  const m = name.match(/^(.*?)\s*\[([^\]]+)\]\s*$/);
  return m ? { base: m[1].trim(), alias: m[2].trim() } : { base: name, alias: null };
}

function indentOf(line) {
  return line.length - line.replace(/^\s*/, '').length;
}

// ── WTC (both full and compact) ──────────────────────────────────────────
// Compact:  Char1: 1x Broodlord (100 points): Broodlord claws & talons
// Full:     5x Barbgaunts (55 points)   [weapons on an indented bullet]
// The count leads the line in both, so one rule covers them.

function parseWtc(text) {
  const re = new RegExp(String.raw`^(?:Char\d+:\s*)?(\d+)\s*x\s+(.+?)\s*${POINTS}`, 'i');
  const units = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || SKIP.test(line) || line.startsWith('•')) continue;
    const m = line.match(re);
    if (!m) continue;
    units.push(makeUnit(cleanName(m[2]), +m[1], +m[3]));
  }
  return units;
}

// ── WarOrgan ─────────────────────────────────────────────────────────────
//   Barbgaunts (55 points)                     <- 2-space indent
//     • 5 Barbgaunts with Barblauncher …       <- count lives here, no "x"
// Single-model units simply have no count bullet.

function parseWarOrgan(text) {
  const lines = text.split(/\r?\n/);
  const head = new RegExp(String.raw`^\s{1,3}(\S.*?)\s*${POINTS}\s*$`, 'i');
  const units = [];
  let section = null;      // current unindented header
  let block = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Unindented, no points: a section header. WarOrgan names an attachment
    // group after its bodyguard unit ("Genestealers"), while plain category
    // headers ("Monster", "Other") match nothing in the section — that
    // difference is the only signal that a group is attached.
    if (line.trim() && !/^\s/.test(line) && !/points?\)/i.test(line) && !SKIP.test(line.trim())) {
      section = line.trim();
      block++;
      continue;
    }
    if (line.includes('•') || SKIP.test(line.trim())) continue;
    const m = line.match(head);
    if (!m) continue;

    let models = 1;
    for (let j = i + 1; j < lines.length; j++) {
      const sub = lines[j];
      if (!sub.trim()) continue;
      if (!sub.includes('•')) break;                    // next unit or section
      if (/\[\+\d+\s*points?\]/i.test(sub)) continue;   // enhancement
      if (/^\s*•\s*Categories:/i.test(sub)) continue;
      const c = sub.match(/^\s*•\s*(\d+)\s+\S.*?\s+with\s+/i);
      if (c) { models = +c[1]; break; }
    }
    const u = makeUnit(cleanName(m[1]), models, +m[2]);
    u._block = block;
    u._section = section;
    units.push(u);
  }

  // Only groups whose header names one of their own units are attachments.
  const byBlock = new Map();
  for (const u of units) {
    if (!byBlock.has(u._block)) byBlock.set(u._block, []);
    byBlock.get(u._block).push(u);
  }
  for (const group of byBlock.values()) {
    if (group.length < 2) continue;
    const header = normalise(group[0]._section ?? '');
    if (!group.some(u => normalise(u.catalogName) === header)) {
      for (const u of group) delete u._block;      // a plain category listing
    }
  }
  for (const u of units) delete u._section;
  return linkBlocks(units);
}

function normalise(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// ── Games Workshop app ───────────────────────────────────────────────────
//   Genestealers (140 points)
//     • 10x Genestealers          <- model group: has deeper children
//       • 10x Genestealer Claws…
//   Broodlord (100 points)
//     • 1x Broodlord claws & talons   <- weapon: no children
//
// Weapon and model bullets are textually identical, so the only reliable
// signal is nesting: a bullet with more-indented bullets under it is a model
// group. Everything else is wargear and leaves the count at 1.

function parseGw(text) {
  const lines = text.split(/\r?\n/);
  const head = new RegExp(String.raw`^(\S.*?)\s*${POINTS}\s*$`, 'i');
  const units = [];
  let started = false;
  let inAttached = false;   // inside the ATTACHED UNITS section
  let block = null;         // index of the current "Attached Unit N" block

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();

    // the army title also looks like a unit line, so wait for the first
    // ALL-CAPS section header before collecting anything
    if (/^[A-Z][A-Z\s]{3,}$/.test(t)) {
      started = true;
      inAttached = /^ATTACHED UNITS$/i.test(t);
      block = null;
      continue;
    }
    // GW brackets each leader+bodyguard pair with its own sub-header
    if (inAttached && /^Attached Unit\s+\d+/i.test(t)) { block = (block ?? -1) + 1; continue; }
    if (!started || line.includes('•') || SKIP.test(t)) continue;

    const m = line.match(head);
    if (!m) continue;

    let models = 0;
    for (let j = i + 1; j < lines.length; j++) {
      const sub = lines[j];
      if (!sub.trim()) continue;
      const ind = indentOf(sub);
      if (ind === 0) break;                       // next unit
      if (!/^\s*•/.test(sub.trim()) && ind === 0) break;

      const c = sub.match(/^\s*•\s*(\d+)\s*x\s+(.+)$/i);
      if (!c) continue;

      const next = lines[j + 1];
      const nested = next && next.trim().startsWith('•') && indentOf(next) > ind;
      if (nested) models += +c[1];
    }
    const u = makeUnit(cleanName(m[1]), models || 1, +m[2]);
    if (inAttached && block !== null) u._block = block;
    units.push(u);
  }
  return linkBlocks(units);
}

// Turns _block groupings into leader → body links. The leader is the smaller
// unit (a character joining a squad); ties fall back to listed order, which
// is how every builder writes them anyway.
function linkBlocks(units) {
  const groups = new Map();
  units.forEach((u, i) => {
    if (u._block === undefined) return;
    if (!groups.has(u._block)) groups.set(u._block, []);
    groups.get(u._block).push(i);
  });

  for (const idx of groups.values()) {
    if (idx.length < 2) continue;
    const bodyIdx = idx.reduce((best, i) =>
      units[i].models > units[best].models ? i : best, idx[0]);
    for (const i of idx) if (i !== bodyIdx) units[i].attachedToIndex = bodyIdx;
  }
  for (const u of units) delete u._block;
  return units;
}

// ── Generic fallback ─────────────────────────────────────────────────────
// Anything with a points value; count taken from a leading "Nx" if present.

function parseGeneric(text) {
  const re = new RegExp(String.raw`^(?:(\d+)\s*x\s+)?(.+?)\s*${POINTS}`, 'i');
  const units = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/^\s*[•\-*]\s*/, '').trim();
    if (!line || SKIP.test(line)) continue;
    const m = line.match(re);
    if (!m) continue;
    const name = cleanName(m[2]);
    if (!name || /^total|^army|^list/i.test(name)) continue;
    units.push(makeUnit(name, m[1] ? +m[1] : 1, +m[3]));
  }
  return units;
}

function makeUnit(rawName, models, points) {
  const { base, alias } = splitAlias(rawName);
  return {
    name: alias || base,     // what shows on the board
    catalogName: base,       // what analytics groups on
    models: Math.max(1, models || 1),
    points: points || 0,
  };
}

// ── Public entry point ───────────────────────────────────────────────────

const PARSERS = { wtc: parseWtc, warorgan: parseWarOrgan, gw: parseGw, generic: parseGeneric };

function parseList(text) {
  const src = String(text ?? '');
  const warnings = [];
  if (!src.trim()) return { ok: false, error: 'Nothing to import.', units: [] };

  const format = detectFormat(src);
  let units = PARSERS[format](src);

  // A recognised format that yields nothing is more likely a detection miss
  // than an empty list, so fall back rather than reporting failure.
  if (!units.length && format !== 'generic') {
    units = parseGeneric(src);
    if (units.length) warnings.push(`Read as ${FORMAT_LABEL[format]} but fell back to generic parsing.`);
  }

  // Duplicate datasheets get a numeric suffix on the board while keeping the
  // shared catalogue name, so two Genestealer broods stay tellable apart
  // without splitting their analytics.
  const seen = new Map();
  for (const u of units) seen.set(u.catalogName, (seen.get(u.catalogName) ?? 0) + 1);
  const used = new Map();
  for (const u of units) {
    if (seen.get(u.catalogName) > 1 && !u.nameIsAlias) {
      const n = (used.get(u.catalogName) ?? 0) + 1;
      used.set(u.catalogName, n);
      if (u.name === u.catalogName) u.name = `${u.catalogName} ${n}`;
    }
  }

  return {
    ok: units.length > 0,
    error: units.length ? null : 'No units found — check the list format.',
    format,
    formatLabel: FORMAT_LABEL[format],
    faction: detectFaction(src),
    listName: detectListName(src),
    totalPoints: units.reduce((s, u) => s + u.points, 0),
    units,
    warnings,
  };
}

function detectFaction(text) {
  const wtc = text.match(/^\+\s*FACTION KEYWORD:\s*(.+)$/mi);
  if (wtc) return wtc[1].trim();
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  // both GW and WarOrgan put the faction on the line after the army title
  for (let i = 1; i < Math.min(4, lines.length); i++) {
    const l = lines[i];
    if (!l || /points|Battle Size|Detachment|Force Disposition/i.test(l)) continue;
    if (l.length < 40) return l;
  }
  return '';
}

function detectListName(text) {
  const first = text.split(/\r?\n/).map(l => l.trim()).find(Boolean) ?? '';
  const m = first.match(/^(.+?)\s*[[(]\s*\d+\s*(?:points?|pts?)/i);
  return m ? m[1].trim() : '';
}

const ListParser = { parseList, detectFormat, FORMAT_LABEL };

if (typeof window !== 'undefined') window.ListParser = ListParser;
if (typeof module !== 'undefined') module.exports = ListParser;
