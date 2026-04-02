import { dbPool } from '../src/db/client.js';
import { computeOverallScoreVariants } from '../src/services/scoring.js';

const OVERALL_PASS_THRESHOLD = 0.5;

function normalizeGrade(value) {
  const normalized = String(value || '').trim().toUpperCase();
  return normalized === 'PASS' ? 'PASS' : 'FAIL';
}

function gradeFromOverallScore(overallScore) {
  return overallScore >= OVERALL_PASS_THRESHOLD ? 'PASS' : 'FAIL';
}

function toPercent(part, total) {
  if (!total) return 0;
  return Number(((part / total) * 100).toFixed(2));
}

function buildMetrics(rows, variantKey) {
  let agreements = 0;
  let falseFails = 0;

  for (const row of rows) {
    const predictedGrade = gradeFromOverallScore(row.scores[variantKey]);

    if (predictedGrade === row.humanGrade) {
      agreements += 1;
    }

    if (predictedGrade === 'FAIL' && row.humanGrade === 'PASS') {
      falseFails += 1;
    }
  }

  return {
    agreement_rate_pct: toPercent(agreements, rows.length),
    false_fail_rate_pct: toPercent(falseFails, rows.length),
    false_fail_count: falseFails
  };
}

async function main() {
  const query = `
    WITH latest_decision AS (
      SELECT DISTINCT ON (ud.evaluation_item_id)
        ud.evaluation_item_id,
        UPPER(ud.final_grade) AS final_grade,
        ud.decided_at
      FROM user_decisions ud
      ORDER BY ud.evaluation_item_id, ud.decided_at DESC
    )
    SELECT
      es.evaluation_id,
      es.dimensions,
      ld.final_grade
    FROM evaluation_signals es
    INNER JOIN latest_decision ld
      ON ld.evaluation_item_id = es.evaluation_item_id
    WHERE es.dimensions IS NOT NULL
    ORDER BY es.created_at DESC
  `;

  const client = await dbPool.connect();

  try {
    const { rows } = await client.query(query);

    const normalizedRows = rows
      .map((row) => {
        const dimensions = row.dimensions || {};
        const scores = computeOverallScoreVariants(dimensions);

        return {
          evaluationId: row.evaluation_id,
          humanGrade: normalizeGrade(row.final_grade),
          scores
        };
      })
      .filter((row) => Number.isFinite(row.scores.include_memorization));

    const baselineMetrics = buildMetrics(normalizedRows, 'include_memorization');
    const subtractMetrics = buildMetrics(normalizedRows, 'subtract_memorization');
    const experimentalMetrics = buildMetrics(normalizedRows, 'core_only_experimental');

    console.log(
      JSON.stringify(
        {
          sample_size: normalizedRows.length,
          threshold: OVERALL_PASS_THRESHOLD,
          variants: {
            include_memorization: baselineMetrics,
            subtract_memorization: subtractMetrics,
            core_only_experimental: experimentalMetrics
          },
          deltas_vs_include_memorization: {
            subtract_memorization: {
              agreement_rate_pct: Number(
                (subtractMetrics.agreement_rate_pct - baselineMetrics.agreement_rate_pct).toFixed(2)
              ),
              false_fail_rate_pct: Number(
                (subtractMetrics.false_fail_rate_pct - baselineMetrics.false_fail_rate_pct).toFixed(2)
              )
            },
            core_only_experimental: {
              agreement_rate_pct: Number(
                (experimentalMetrics.agreement_rate_pct - baselineMetrics.agreement_rate_pct).toFixed(2)
              ),
              false_fail_rate_pct: Number(
                (experimentalMetrics.false_fail_rate_pct - baselineMetrics.false_fail_rate_pct).toFixed(2)
              )
            }
          }
        },
        null,
        2
      )
    );
  } finally {
    client.release();
    await dbPool.end();
  }
}

main().catch((error) => {
  console.error('compare-overall-variants failed', {
    message: error.message,
    stack: error.stack
  });
  process.exit(1);
});
