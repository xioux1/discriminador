#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
SUBJECT_PREFIX="${SUBJECT_PREFIX:-QA-MVP0-$(date -u +%Y%m%dT%H%M%SZ)}"
REPORT_PATH="${REPORT_PATH:-docs/qa/mvp0-qa-report-latest.md}"

for cmd in curl jq python3 psql; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing required command: $cmd" >&2
    exit 1
  fi
done

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is required for persistence checks." >&2
  exit 1
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

latencies_file="$TMP_DIR/latencies.txt"
: > "$latencies_file"

pass_count=0
fail_count=0

record_case() {
  local case_id="$1"
  local status="$2"
  local note="$3"
  printf "%s|%s|%s\n" "$case_id" "$status" "$note" >> "$TMP_DIR/case_results.txt"
}

expect_http_code() {
  local expected="$1"
  local actual="$2"
  local context="$3"
  if [[ "$expected" != "$actual" ]]; then
    echo "[FAIL] $context: expected HTTP $expected got $actual" >&2
    fail_count=$((fail_count + 1))
    return 1
  fi
  pass_count=$((pass_count + 1))
}

# Case 01: invalid short fields (validation/UI equivalent payload check)
invalid_payload='{"prompt_text":"short","user_answer_text":"bad","expected_answer_text":"tiny"}'
invalid_response_file="$TMP_DIR/case01_invalid.json"
invalid_code="$(curl -sS -o "$invalid_response_file" -w '%{http_code}' \
  -H 'Content-Type: application/json' \
  -d "$invalid_payload" \
  "$BASE_URL/evaluate")"

if expect_http_code "422" "$invalid_code" "Case 01 invalid evaluate"; then
  if jq -e '.error == "validation_error" and (.details | length >= 3)' "$invalid_response_file" >/dev/null; then
    record_case "01" "PASS" "Short-field validation rejected with detailed field errors."
  else
    fail_count=$((fail_count + 1))
    record_case "01" "FAIL" "Validation payload did not include expected detail structure."
  fi
else
  record_case "01" "FAIL" "Invalid payload was not rejected as expected."
fi

# Cases 02-10: valid flow + result fields + decision actions
# Format: case_id|action|prompt|user_answer|expected_answer
cat > "$TMP_DIR/cases.tsv" <<'CASES'
02|accept|Define photosynthesis in one sentence.|Photosynthesis converts light into chemical energy in plants.|Photosynthesis is the process where plants use light, water and CO2 to make glucose and release oxygen.
03|correct-pass|Explain TCP handshake.|TCP uses SYN and ACK packets and creates a reliable session.|TCP three-way handshake: SYN, SYN-ACK, ACK before data transfer.
04|correct-fail|What is polymorphism in OOP?|It means objects can take many forms but I am not sure about overriding.|Polymorphism allows one interface with multiple implementations, e.g. method overriding.
05|uncertain|Describe HTTP status 404.|404 means the server did not find the resource requested.|HTTP 404 Not Found indicates the origin server cannot find the target resource.
06|accept|Define database transaction atomicity.|Atomicity means all operations in a transaction complete or none do.|Atomicity guarantees all-or-nothing execution in a transaction.
07|correct-pass|What is eventual consistency?|It means replicas can be stale but converge after propagation.|Eventual consistency means distributed replicas may diverge temporarily but converge over time.
08|correct-fail|Explain normalization in databases.|Normalization is making indexes faster.|Normalization structures relational data to reduce redundancy and anomalies.
09|accept|Define idempotency in APIs.|Idempotency means repeating a request has the same effect as doing it once.|Idempotent operations produce the same state after repeated identical requests.
10|uncertain|What is a race condition?|A race condition happens when timing of threads changes outcome.|Race condition: program behavior depends on relative timing/interleaving of concurrent operations.
CASES

while IFS='|' read -r case_id action prompt user_answer expected_answer; do
  subject="${SUBJECT_PREFIX}-${case_id}"

  request_json="$(jq -nc \
    --arg p "$prompt" \
    --arg u "$user_answer" \
    --arg e "$expected_answer" \
    --arg s "$subject" \
    '{prompt_text:$p,user_answer_text:$u,expected_answer_text:$e,subject:$s}')"

  evaluate_file="$TMP_DIR/evaluate_${case_id}.json"
  t0="$(date +%s%3N)"
  eval_code="$(curl -sS -o "$evaluate_file" -w '%{http_code}' \
    -H 'Content-Type: application/json' \
    -d "$request_json" \
    "$BASE_URL/evaluate")"
  t1="$(date +%s%3N)"
  latency_ms=$((t1 - t0))
  echo "$latency_ms" >> "$latencies_file"

  if ! expect_http_code "200" "$eval_code" "Case ${case_id} evaluate"; then
    record_case "$case_id" "FAIL" "Evaluate endpoint failed (HTTP $eval_code)."
    continue
  fi

  if ! jq -e '.suggested_grade and (.overall_score|type=="number") and (.model_confidence|type=="number") and (.justification_short|type=="string") and (.dimensions|type=="object")' "$evaluate_file" >/dev/null; then
    fail_count=$((fail_count + 1))
    record_case "$case_id" "FAIL" "Result card fields missing from evaluate payload."
    continue
  fi

  suggested_grade="$(jq -r '.suggested_grade' "$evaluate_file")"
  final_grade=""
  accepted_suggestion="false"
  correction_reason=""

  case "$action" in
    accept)
      final_grade="$suggested_grade"
      accepted_suggestion="true"
      ;;
    correct-pass)
      final_grade="PASS"
      accepted_suggestion="false"
      correction_reason="Manual correction to pass for borderline response."
      ;;
    correct-fail)
      final_grade="FAIL"
      accepted_suggestion="false"
      correction_reason="Manual correction to fail due to conceptual gap."
      ;;
    uncertain)
      final_grade=""
      accepted_suggestion="false"
      correction_reason="Marked uncertain pending human review."
      ;;
    *)
      echo "Unsupported action: $action" >&2
      exit 1
      ;;
  esac

  decision_json="$(jq -nc \
    --arg p "$prompt" \
    --arg u "$user_answer" \
    --arg e "$expected_answer" \
    --arg s "$subject" \
    --arg a "$action" \
    --arg fg "$final_grade" \
    --argjson accepted "$accepted_suggestion" \
    --arg cr "$correction_reason" \
    --slurpfile result "$evaluate_file" \
    '{
      prompt_text:$p,
      user_answer_text:$u,
      expected_answer_text:$e,
      subject:$s,
      evaluation_result:$result[0],
      action:$a,
      final_grade:(if $fg=="" then null else $fg end),
      accepted_suggestion:$accepted,
      correction_reason:(if $cr=="" then null else $cr end)
    }')"

  decision_file="$TMP_DIR/decision_${case_id}.json"
  decision_code="$(curl -sS -o "$decision_file" -w '%{http_code}' \
    -H 'Content-Type: application/json' \
    -d "$decision_json" \
    "$BASE_URL/decision")"

  if ! expect_http_code "201" "$decision_code" "Case ${case_id} decision"; then
    record_case "$case_id" "FAIL" "Decision endpoint failed (HTTP $decision_code)."
    continue
  fi

  if jq -e '.status=="saved" and .success==true and .decision.action' "$decision_file" >/dev/null; then
    record_case "$case_id" "PASS" "Evaluate + decision succeeded (${action}); latency=${latency_ms}ms."
  else
    fail_count=$((fail_count + 1))
    record_case "$case_id" "FAIL" "Decision response payload missing success feedback fields."
  fi
done < "$TMP_DIR/cases.tsv"

read -r p50 p95 < <(python3 - "$latencies_file" <<'PY'
import sys
from math import ceil

with open(sys.argv[1], 'r', encoding='utf-8') as f:
    values = [int(line.strip()) for line in f if line.strip()]

if not values:
    print("0 0")
    raise SystemExit(0)

values.sort()

def percentile(sorted_vals, p):
    idx = max(0, ceil((p / 100) * len(sorted_vals)) - 1)
    return sorted_vals[idx]

print(percentile(values, 50), percentile(values, 95))
PY
)

# Persistence verification across required tables
persistence_tsv="$TMP_DIR/persistence.tsv"
psql "$DATABASE_URL" -At -F $'\t' -v ON_ERROR_STOP=1 <<SQL > "$persistence_tsv"
WITH target_items AS (
  SELECT id
  FROM evaluation_items
  WHERE input_payload->>'subject' LIKE '${SUBJECT_PREFIX}-%'
), counts AS (
  SELECT
    (SELECT COUNT(*) FROM evaluation_items ei WHERE ei.id IN (SELECT id FROM target_items)) AS evaluation_items_count,
    (SELECT COUNT(*) FROM grade_suggestions gs WHERE gs.evaluation_item_id IN (SELECT id FROM target_items)) AS grade_suggestions_count,
    (SELECT COUNT(*) FROM user_decisions ud WHERE ud.evaluation_item_id IN (SELECT id FROM target_items)) AS user_decisions_count,
    (
      SELECT COUNT(*)
      FROM target_items ti
      JOIN grade_suggestions gs ON gs.evaluation_item_id = ti.id
      JOIN user_decisions ud ON ud.evaluation_item_id = ti.id
    ) AS fully_linked_count
)
SELECT evaluation_items_count, grade_suggestions_count, user_decisions_count, fully_linked_count
FROM counts;
SQL

IFS=$'\t' read -r evaluation_items_count grade_suggestions_count user_decisions_count fully_linked_count < "$persistence_tsv"

expected_success_cases=9

flow_status="PASS"
latency_status="PASS"
persistence_status="PASS"

if [[ "$evaluation_items_count" -ne "$expected_success_cases" || "$grade_suggestions_count" -ne "$expected_success_cases" || "$user_decisions_count" -ne "$expected_success_cases" || "$fully_linked_count" -ne "$expected_success_cases" ]]; then
  persistence_status="FAIL"
  fail_count=$((fail_count + 1))
fi

if (( p50 > 2000 || p95 > 4000 )); then
  latency_status="FAIL"
  fail_count=$((fail_count + 1))
fi

if (( fail_count > 0 )); then
  flow_status="FAIL"
fi

mkdir -p "$(dirname "$REPORT_PATH")"
{
  echo "# MVP0 QA report"
  echo
  echo "- Run timestamp (UTC): $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "- Base URL: $BASE_URL"
  echo "- Subject prefix: $SUBJECT_PREFIX"
  echo
  echo "## Consecutive case outcomes (10 cases)"
  echo
  echo "| Case | Status | Outcome |"
  echo "|---|---|---|"
  while IFS='|' read -r case_id status note; do
    echo "| $case_id | $status | $note |"
  done < "$TMP_DIR/case_results.txt"
  echo
  echo "## Persistence verification"
  echo
  echo "- evaluation_items rows: $evaluation_items_count"
  echo "- grade_suggestions rows: $grade_suggestions_count"
  echo "- user_decisions rows: $user_decisions_count"
  echo "- fully linked rows across all three tables: $fully_linked_count"
  echo
  echo "## Latency summary"
  echo
  echo "- p50: ${p50}ms"
  echo "- p95: ${p95}ms"
  echo
  echo "## Mapping to docs/mvp0-scope.md acceptance criteria"
  echo
  echo "| Scope criterion | Expected | Observed | Result |"
  echo "|---|---|---|---|"
  echo "| Flujo punta a punta (10 casos consecutivos) | 10 casos sin bloqueos críticos | Ver tabla de 10 casos consecutivos | $flow_status |"
  echo "| Latencia percibida | p50 <= 2000ms; p95 <= 4000ms | p50=${p50}ms, p95=${p95}ms | $latency_status |"
  echo "| Guardado correcto | 100% inputs+resultado+decisión+timestamp persistidos y recuperables | eval=$evaluation_items_count, suggestions=$grade_suggestions_count, decisions=$user_decisions_count, linked=$fully_linked_count | $persistence_status |"
} > "$REPORT_PATH"

echo "QA suite completed. Report: $REPORT_PATH"
if (( fail_count > 0 )); then
  echo "Suite finished with failures."
  exit 2
fi

echo "Suite finished successfully."
