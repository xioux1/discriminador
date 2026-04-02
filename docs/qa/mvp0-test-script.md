# MVP0 test script (10 consecutive cases)

Run this script to execute the full requested QA flow:

```bash
DATABASE_URL=postgres://... BASE_URL=http://localhost:3000 ./scripts/qa/run_mvp0_suite.sh
```

## What it covers

1. Invalid short-field submission (`/evaluate`) and validation error confirmation.
2. Nine valid end-to-end submissions with result payload checks.
3. All decision actions (`accept`, `correct-pass`, `correct-fail`, `uncertain`) with success feedback checks.
4. Persistence verification across `evaluation_items`, `grade_suggestions`, `user_decisions`.
5. Latency measurement from evaluate click request to result response (`p50`, `p95`).
6. Auto-generated short QA report mapped to `docs/mvp0-scope.md` acceptance criteria.

## Output

- Report path (default): `docs/qa/mvp0-qa-report-latest.md`
- The report contains:
  - case-by-case outcomes,
  - persistence counts and linkage,
  - latency percentiles,
  - scope criteria mapping table.
