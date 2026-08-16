'use strict';

// Schema regression check. Runs the real schema against an in-process
// Postgres emulator (pg-mem) so a broken migration is caught without
// provisioning a database:  npm test
//
// KNOWN pg-mem GAPS — these are emulator limitations, not schema problems,
// and are deliberately avoided below. Verified by isolating each one:
//   * round(float, int) is not implemented
//   * FILTER (WHERE ...) is parsed but ignored
//   * GROUP BY with two aliases of the same table mislabels the projected
//     columns (the grouping keys themselves are correct — the same query
//     without GROUP BY returns the right names)
//   * re-running CREATE TABLE IF NOT EXISTS throws instead of no-opping, so
//     schema idempotency (init() runs on every boot) is NOT covered here
// Anything relying on those must be checked against real Postgres.

const fs   = require('fs');
const path = require('path');
const { newDb } = require('pg-mem');

const SCHEMA = fs.readFileSync(path.join(__dirname, 'db.js'), 'utf8')
  .match(/const SCHEMA = `([\s\S]*?)`;/)[1];

const EFFECT_VALUE = { whiff: 0, light: 0.10, moderate: 0.33, heavy: 0.66, wiped: 1 };

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail && !ok ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

(async () => {
  const pool = new (newDb().adapters.createPg().Pool)();

  await pool.query(SCHEMA);
  check('schema executes', true);

  await pool.query(`INSERT INTO users (google_sub, email, name) VALUES ('sub1','a@b.c','Sam')`);

  // Same unit names across two battles must resolve to one catalogue entry;
  // that is what makes cross-battle analytics possible at all.
  const cat = {};
  for (const [norm, disp] of [['redemptor', 'Redemptor'], ['boyz mob', 'Boyz Mob']]) {
    const { rows } = await pool.query(
      `INSERT INTO unit_catalog (norm_name, display_name) VALUES ($1,$2) RETURNING id`,
      [norm, disp]);
    cat[norm] = rows[0].id;
  }

  let n = 0;
  async function seedBattle(token, attacks) {
    const { rows } = await pool.query(
      `INSERT INTO battles (token, owner_id, name, side_a_name, side_b_name)
       VALUES ($1, 1, $2, 'Ultramarines', 'Orks') RETURNING id`, [token, token]);
    const bid = rows[0].id;
    const ids = {};
    for (const [norm, side] of [['redemptor', 'A'], ['boyz mob', 'B']]) {
      const uid = `u${++n}`;
      ids[norm] = uid;
      await pool.query(
        `INSERT INTO battle_units (id, battle_id, catalog_id, name, side, kind, starting_strength)
         VALUES ($1,$2,$3,$4,$5,'unit',10)`, [uid, bid, cat[norm], norm, side]);
    }
    let seq = 0;
    for (const [actor, target, effect] of attacks) {
      await pool.query(
        `INSERT INTO battle_events (battle_id, seq, event_uuid, round, side, phase, type,
                                    actor_unit_id, target_unit_id, effect, effect_value)
         VALUES ($1,$2,$3,1,'A','shooting','shoot',$4,$5,$6,$7)`,
        [bid, ++seq, `${token}-${seq}`, ids[actor], ids[target], effect, EFFECT_VALUE[effect]]);
    }
  }

  await seedBattle('AAA111', [['redemptor', 'boyz mob', 'heavy'],
                              ['redemptor', 'boyz mob', 'moderate']]);
  await seedBattle('BBB222', [['redemptor', 'boyz mob', 'wiped']]);
  check('two battles seeded', true);

  // The joins the analytics queries depend on. Checked WITHOUT GROUP BY
  // because pg-mem mislabels grouped output (see gaps above).
  const joined = await pool.query(`
    SELECT ac.display_name AS attacker, tc.display_name AS defender, e.effect_value
    FROM battle_events e
    JOIN battle_units au ON au.id = e.actor_unit_id
    JOIN battle_units tu ON tu.id = e.target_unit_id
    JOIN unit_catalog ac ON ac.id = au.catalog_id
    JOIN unit_catalog tc ON tc.id = tu.catalog_id
    WHERE e.type IN ('shoot','fight')`);

  check('attacker/defender resolve through the catalogue',
    joined.rows.length === 3 &&
    joined.rows.every(r => r.attacker === 'Redemptor' && r.defender === 'Boyz Mob'),
    JSON.stringify(joined.rows[0]));

  // The headline number: effectiveness averaged across SEPARATE battles.
  const avg = joined.rows.reduce((s, r) => s + r.effect_value, 0) / joined.rows.length;
  const expected = (0.66 + 0.33 + 1) / 3;
  check('cross-battle averaging', Math.abs(avg - expected) < 1e-6,
    `got ${avg}, expected ${expected}`);

  const scoped = await pool.query(`SELECT token FROM battles WHERE owner_id = 1 ORDER BY token`);
  check('battles scope to their owner',
    scoped.rows.map(r => r.token).join(',') === 'AAA111,BBB222');

  const cascade = await pool.query(`SELECT count(*)::int AS c FROM battle_events`);
  check('events stored', cascade.rows[0].c === 3);

  console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('ERROR', e.message); process.exit(1); });
