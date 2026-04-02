#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { computeOverallScoreVariants } from '../../backend/src/services/scoring.js';

const OVERALL_PASS_THRESHOLD = 0.5;
const SIGNIFICANT_AGREEMENT_DROP = 0.02;

function parseArgs(argv) {
  const args = {
    dataset: 'db/seeds/internal_eval_dataset_v1.json',
    baseline: 'include_memorization',
    candidate: 'core_guardrail_v1',
    output: 'docs/qa/offline-eval-report-latest.md'
  };

  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--dataset') args.dataset = argv[++i];
    if (token === '--baseline') args.baseline = argv[++i];
    if (token === '--candidate') args.candidate = argv[++i];
    if (token === '--output') args.output = argv[++i];
  }

  return args;
}

function normalizeGrade(value) {
  return String(value || '').trim().toUpperCase() === 'PASS' ? 'PASS' : 'FAIL';
}

function scoreToGrade(score) {
  return score >= OVERALL_PASS_THRESHOLD ? 'PASS' : 'FAIL';
}

function buildPredictor(strategy) {
  const byVariant = new Set(['include_memorization', 'subtract_memorization', 'core_only_experimental']);

  if (byVariant.has(strategy)) {
    return (dimensions) => scoreToGrade(computeOverallScoreVariants(dimensions)[strategy]);
  }

  if (strategy === 'core_guardrail_v1') {
    return (dimensions) => {
      if (dimensions.core_idea >= 0.5 && dimensions.conceptual_accuracy >= 0.5) {
        return 'PASS';
      }
      return scoreToGrade(computeOverallScoreVariants(dimensions).include_memorization);
    };
  }

  throw new Error(`Unknown strategy: ${strategy}`);
}

function ratio(numerator, denominator) {
  if (!denominator) return 0;
  return Number((numerator / denominator).toFixed(4));
}

function evaluate(records, predictor) {
  let agreements = 0;
  let overrides = 0;
  let falseFails = 0;
  let humanPassCount = 0;
  let coveredCoreIdea = 0;

  for (const record of records) {
    const human = normalizeGrade(record.human_final_grade);
    const predicted = predictor(record.dimensions);

    if (human === 'PASS') {
      humanPassCount += 1;
    }

    if (predicted === human) {
      agreements += 1;
    } else {
      overrides += 1;
    }

    if (predicted === 'FAIL' && human === 'PASS') {
      falseFails += 1;
    }

    if (human === 'PASS' && predicted === 'PASS' && Number(record.dimensions.core_idea) >= 0.5) {
      coveredCoreIdea += 1;
    }
  }

  return {
    sample_size: records.length,
    false_fail_rate: ratio(falseFails, humanPassCount),
    override_rate: ratio(overrides, records.length),
    agreement_with_human: ratio(agreements, records.length),
    coverage_of_core_idea: ratio(coveredCoreIdea, humanPassCount)
  };
}

function buildPromotionDecision(baseline, candidate) {
  const improvedFalseFail = candidate.false_fail_rate < baseline.false_fail_rate;
  const agreementDrop = baseline.agreement_with_human - candidate.agreement_with_human;
  const significantDrop = agreementDrop > SIGNIFICANT_AGREEMENT_DROP;

  return {
    promote: improvedFalseFail && !significantDrop,
    rule: 'No desplegar si no mejora false_fail_rate sin degradar significativamente agreement_with_human.',
    improved_false_fail_rate: improvedFalseFail,
    agreement_drop: Number(agreementDrop.toFixed(4)),
    significant_agreement_drop: significantDrop,
    significant_drop_threshold: SIGNIFICANT_AGREEMENT_DROP
  };
}

function buildMarkdownReport({ args, dataset, baselineMetrics, candidateMetrics, promotion }) {
  return `# Reporte offline de QA (${new Date().toISOString()})

- Dataset: \`${args.dataset}\`
- Versión dataset: \`${dataset.dataset_version}\`
- Baseline: \`${args.baseline}\`
- Candidato: \`${args.candidate}\`

## Métricas mínimas

| métrica | baseline | candidato | delta |
|---|---:|---:|---:|
| false_fail_rate | ${baselineMetrics.false_fail_rate} | ${candidateMetrics.false_fail_rate} | ${(candidateMetrics.false_fail_rate - baselineMetrics.false_fail_rate).toFixed(4)} |
| override_rate | ${baselineMetrics.override_rate} | ${candidateMetrics.override_rate} | ${(candidateMetrics.override_rate - baselineMetrics.override_rate).toFixed(4)} |
| agreement_with_human | ${baselineMetrics.agreement_with_human} | ${candidateMetrics.agreement_with_human} | ${(candidateMetrics.agreement_with_human - baselineMetrics.agreement_with_human).toFixed(4)} |
| coverage_of_core_idea | ${baselineMetrics.coverage_of_core_idea} | ${candidateMetrics.coverage_of_core_idea} | ${(candidateMetrics.coverage_of_core_idea - baselineMetrics.coverage_of_core_idea).toFixed(4)} |

## Criterio de promoción

- Regla: ${promotion.rule}
- ¿Mejora false_fail_rate?: **${promotion.improved_false_fail_rate ? 'sí' : 'no'}**
- Caída de acuerdo global: **${promotion.agreement_drop}** (umbral significativo: ${promotion.significant_drop_threshold})
- ¿Caída significativa?: **${promotion.significant_agreement_drop ? 'sí' : 'no'}**
- **Resultado final: ${promotion.promote ? 'PROMOVER' : 'NO PROMOVER'}**
`;
}

function main() {
  const args = parseArgs(process.argv);
  const datasetPath = path.resolve(args.dataset);
  const outputPath = path.resolve(args.output);
  const dataset = JSON.parse(fs.readFileSync(datasetPath, 'utf8'));

  if (!Array.isArray(dataset.records) || dataset.records.length === 0) {
    throw new Error('Dataset inválido: records debe contener casos.');
  }

  const baselinePredictor = buildPredictor(args.baseline);
  const candidatePredictor = buildPredictor(args.candidate);

  const baselineMetrics = evaluate(dataset.records, baselinePredictor);
  const candidateMetrics = evaluate(dataset.records, candidatePredictor);
  const promotion = buildPromotionDecision(baselineMetrics, candidateMetrics);

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const report = buildMarkdownReport({
    args,
    dataset,
    baselineMetrics,
    candidateMetrics,
    promotion
  });
  fs.writeFileSync(outputPath, report, 'utf8');

  const payload = {
    dataset_version: dataset.dataset_version,
    baseline: args.baseline,
    candidate: args.candidate,
    baseline_metrics: baselineMetrics,
    candidate_metrics: candidateMetrics,
    promotion
  };

  console.log(JSON.stringify(payload, null, 2));
  console.log(`Report written to ${path.relative(process.cwd(), outputPath)}`);
}

main();
