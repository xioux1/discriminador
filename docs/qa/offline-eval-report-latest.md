# Reporte offline de QA (2026-04-02T21:43:16.720Z)

- Dataset: `db/seeds/internal_eval_dataset_v1.json`
- Versión dataset: `2026-04-02.v1`
- Baseline: `include_memorization`
- Candidato: `core_guardrail_v1`

## Métricas mínimas

| métrica | baseline | candidato | delta |
|---|---:|---:|---:|
| false_fail_rate | 0.375 | 0 | -0.3750 |
| override_rate | 0.3 | 0 | -0.3000 |
| agreement_with_human | 0.7 | 1 | 0.3000 |
| coverage_of_core_idea | 0.625 | 1 | 0.3750 |

## Criterio de promoción

- Regla: No desplegar si no mejora false_fail_rate sin degradar significativamente agreement_with_human.
- ¿Mejora false_fail_rate?: **sí**
- Caída de acuerdo global: **-0.3** (umbral significativo: 0.02)
- ¿Caída significativa?: **no**
- **Resultado final: PROMOVER**
