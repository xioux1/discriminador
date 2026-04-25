/**
 * fix-variant-orphan-cards.js
 *
 * Finds cards in the `cards` table whose prompt_text + expected_answer_text
 * exactly match a row in `card_variants`. These are duplicates created by the
 * syncSchedulerCard bug — variants were not recognised and spawned new cards.
 *
 * For each orphan:
 *  - If the orphan has review history (review_count > 0), merge its SM-2 data
 *    into the parent card (keep the better-trained state).
 *  - Archive the orphan card (archived_at = now()).
 *  - Re-parent any micro_cards that point to the orphan → point to the real card.
 *
 * Run with:  node backend/scripts/fix-variant-orphan-cards.js
 * Add --dry-run to preview without writing.
 */

import pg from 'pg';
import 'dotenv/config';

const { Pool } = pg;
const DRY_RUN = process.argv.includes('--dry-run');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const client = await pool.connect();
  try {
    // 1. Find orphan cards
    const { rows: orphans } = await client.query(`
      SELECT c.id        AS orphan_id,
             c.user_id,
             c.subject,
             c.review_count,
             c.pass_count,
             c.ease_factor,
             c.interval_days,
             c.stability,
             c.difficulty,
             c.next_review_at,
             c.last_reviewed_at,
             cv.card_id  AS parent_id
      FROM cards c
      JOIN card_variants cv
        ON cv.prompt_text          = c.prompt_text
       AND cv.expected_answer_text = c.expected_answer_text
      WHERE c.archived_at IS NULL
      ORDER BY c.user_id, cv.card_id
    `);

    console.log(`Found ${orphans.length} orphan card(s)${DRY_RUN ? ' (dry-run — no writes)' : ''}.`);
    if (orphans.length === 0) return;

    for (const o of orphans) {
      console.log(`  orphan=${o.orphan_id} → parent=${o.parent_id}  reviews=${o.review_count}  subject=${o.subject ?? '(sin materia)'}`);
    }

    if (DRY_RUN) return;

    await client.query('BEGIN');

    for (const o of orphans) {
      // Re-parent any micro_cards
      await client.query(
        `UPDATE micro_cards SET parent_card_id = $1 WHERE parent_card_id = $2`,
        [o.parent_id, o.orphan_id]
      );

      // If orphan was actually studied, merge SM-2 into parent (take better interval)
      if (o.review_count > 0) {
        await client.query(`
          UPDATE cards
          SET review_count     = review_count + $1,
              pass_count       = pass_count   + $2,
              interval_days    = GREATEST(interval_days, $3),
              ease_factor      = GREATEST(ease_factor,   $4),
              stability        = GREATEST(stability,     $5::numeric),
              difficulty       = LEAST   (difficulty,    $6::numeric),
              next_review_at   = LEAST   (next_review_at, $7),
              last_reviewed_at = GREATEST(COALESCE(last_reviewed_at, '1970-01-01'), $8),
              updated_at       = now()
          WHERE id = $9
        `, [
          o.review_count, o.pass_count,
          o.interval_days, o.ease_factor,
          o.stability, o.difficulty,
          o.next_review_at, o.last_reviewed_at ?? new Date(0),
          o.parent_id
        ]);
      }

      // Archive the orphan
      await client.query(
        `UPDATE cards SET archived_at = now(), updated_at = now() WHERE id = $1`,
        [o.orphan_id]
      );
    }

    await client.query('COMMIT');
    console.log('Done. Orphan cards archived and SM-2 data merged into parent cards.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
