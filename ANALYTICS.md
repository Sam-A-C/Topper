# Analytics

Every battle is stored as **rows, not blobs**, so cross-game questions are plain SQL. This file is the reference for asking them.

## The two design choices that make this work

**1. Events are typed rows.** `battle_events` has real columns — `effect_value` is a number you can `AVG()` directly, `distance` is precomputed. There is no JSON to unpack and no need to load battles into application memory.

**2. Units resolve to a shared catalogue.** Every `battle_units` row points at a `unit_catalog` entry keyed on a normalised name (casefolded, punctuation stripped, whitespace collapsed). "Intercessors", "intercessors" and "Intercessors " are one catalogue entry, so they aggregate together across games.

Without the catalogue, every cross-game query would be grouping on free text and quietly splitting the same unit into several buckets.

## The effectiveness scale

`effect_value` is the numeric form of the 5-point scale:

| effect | value |
|---|---|
| `whiff` | 0.00 |
| `light` | 0.10 |
| `moderate` | 0.33 |
| `heavy` | 0.66 |
| `wiped` | 1.00 |

It approximates "fraction of the target removed". Averaging it gives a usable effectiveness score; it is **not** a wound count and should never be presented as precision.

---

## Queries

### Which unit beats which, across every game

The headline question — attacker vs defender, averaged over all battles ever recorded.

```sql
SELECT ac.display_name                          AS attacker,
       tc.display_name                          AS defender,
       count(*)                                 AS engagements,
       round(avg(e.effect_value)::numeric, 3)   AS avg_effectiveness,
       count(*) FILTER (WHERE e.effect = 'wiped') AS times_wiped
FROM battle_events e
JOIN battle_units au ON au.id = e.actor_unit_id
JOIN battle_units tu ON tu.id = e.target_unit_id
JOIN unit_catalog ac ON ac.id = au.catalog_id
JOIN unit_catalog tc ON tc.id = tu.catalog_id
WHERE e.type IN ('shoot', 'fight')
GROUP BY ac.display_name, tc.display_name
HAVING count(*) >= 3                -- drop one-off noise
ORDER BY avg_effectiveness DESC;
```

The `attack_log` view wraps those joins, so the same thing shortens to:

```sql
SELECT actor_name, target_name, count(*), avg(effect_value)
FROM attack_log
GROUP BY actor_name, target_name;
```

### Shooting vs melee for one unit

```sql
SELECT ac.display_name AS unit,
       e.type          AS how,
       count(*)        AS engagements,
       round(avg(e.effect_value)::numeric, 3) AS avg_effectiveness
FROM battle_events e
JOIN battle_units au ON au.id = e.actor_unit_id
JOIN unit_catalog ac ON ac.id = au.catalog_id
WHERE e.type IN ('shoot', 'fight')
GROUP BY ac.display_name, e.type
ORDER BY unit, how;
```

### Which units die most often

```sql
SELECT tc.display_name AS unit,
       count(*) FILTER (WHERE e.effect = 'wiped') AS times_destroyed,
       count(DISTINCT e.battle_id)                AS battles_appeared_in
FROM battle_events e
JOIN battle_units tu ON tu.id = e.target_unit_id
JOIN unit_catalog tc ON tc.id = tu.catalog_id
GROUP BY tc.display_name
ORDER BY times_destroyed DESC;
```

### Does going first win games?

```sql
WITH final AS (
  SELECT battle_id,
         sum(vp) FILTER (WHERE side = 'A') AS vp_a,
         sum(vp) FILTER (WHERE side = 'B') AS vp_b
  FROM battle_events WHERE type = 'score' GROUP BY battle_id)
SELECT count(*) FILTER (WHERE vp_a > vp_b) AS first_player_wins,
       count(*) FILTER (WHERE vp_b > vp_a) AS second_player_wins,
       count(*) FILTER (WHERE vp_a = vp_b) AS draws
FROM final;
```

### When does the killing happen

```sql
SELECT round,
       phase,
       count(*) FILTER (WHERE effect = 'wiped') AS units_destroyed,
       round(avg(effect_value)::numeric, 3)     AS avg_effectiveness
FROM battle_events
WHERE type IN ('shoot', 'fight')
GROUP BY round, phase
ORDER BY round, phase;
```

### Charge success rate by unit

```sql
SELECT ac.display_name AS unit,
       count(*)                                   AS charges,
       count(*) FILTER (WHERE e.success)          AS made_it,
       round(100.0 * count(*) FILTER (WHERE e.success) / count(*), 1) AS pct
FROM battle_events e
JOIN battle_units au ON au.id = e.actor_unit_id
JOIN unit_catalog ac ON ac.id = au.catalog_id
WHERE e.type = 'charge'
GROUP BY ac.display_name
HAVING count(*) >= 3
ORDER BY pct DESC;
```

### Average movement per unit

`distance` is precomputed on insert, so this needs no geometry.

```sql
SELECT ac.display_name AS unit,
       e.move_type,
       round(avg(e.distance)::numeric, 1) AS avg_inches
FROM battle_events e
JOIN battle_units au ON au.id = e.actor_unit_id
JOIN unit_catalog ac ON ac.id = au.catalog_id
WHERE e.type = 'move' AND e.distance IS NOT NULL
GROUP BY ac.display_name, e.move_type
ORDER BY unit;
```

---

## Caveats worth remembering

- **Small samples lie.** With a handful of games, one lucky Redemptor volley dominates its matchup. The `HAVING count(*) >= 3` filters above exist for that reason — raise the threshold as the dataset grows.
- **Effectiveness is subjective.** It is whoever was logging deciding "that felt heavy". It reflects perception as much as outcome, and different people will log the same volley differently.
- **The catalogue matches on names only.** Two genuinely different units with the same name collapse together; the same unit typed two very different ways stays split. Merge entries in `unit_catalog` by hand if it drifts.
- **Terrain and objectives have no catalogue entry** (`catalog_id IS NULL`) — the joins above filter them out naturally, but a `LEFT JOIN` would include them.

## Housekeeping

Find near-duplicate catalogue entries that should probably be merged:

```sql
SELECT a.id, a.display_name, b.id, b.display_name
FROM unit_catalog a
JOIN unit_catalog b ON b.id > a.id AND b.norm_name LIKE a.norm_name || '%'
ORDER BY a.display_name;
```

Merging entry `b` into `a`:

```sql
UPDATE battle_units SET catalog_id = :a WHERE catalog_id = :b;
DELETE FROM unit_catalog WHERE id = :b;
```
