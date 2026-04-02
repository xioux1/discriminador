import json
import os
import subprocess


def _run_node_scoring(enable_preprocessing_v2: bool):
    env = os.environ.copy()
    env["ENABLE_PREPROCESSING_V2"] = "true" if enable_preprocessing_v2 else "false"
    env["ENABLE_SEMANTIC_CORE_IDEA_RESCUE"] = "true"
    env["ENABLE_EXPERIMENTAL_OVERALL_CORE_ONLY"] = "false"

    node_script = r'''
import { scoreEvaluation, scoreEvaluationOfflineComparison } from './backend/src/services/scoring.js';

const payload = {
  evaluation_id: 'eval-preprocessing-integration',
  prompt_text: 'Explica train_test_split en RN',
  subject: 'RN',
  expected_answer_text: 'En RN se recomienda shuffle antes de separar y stratify para mantener proporción de clases.',
  user_answer_text: 'Antes de separar conviene mezclar de forma aleatoria los datos y conservar la distribucion por clase.'
};

const result = scoreEvaluation(payload);
const comparison = scoreEvaluationOfflineComparison(payload);
console.log(JSON.stringify({ result, comparison }));
'''

    completed = subprocess.run(
        ["node", "--input-type=module", "-e", node_script],
        check=True,
        capture_output=True,
        text=True,
        env=env,
    )
    output_lines = [line for line in completed.stdout.splitlines() if line.strip()]
    return json.loads(output_lines[-1])


def test_score_evaluation_contract_is_stable_with_preprocessing_v2_toggle():
    baseline = _run_node_scoring(enable_preprocessing_v2=False)["result"]
    candidate = _run_node_scoring(enable_preprocessing_v2=True)["result"]

    assert set(baseline.keys()) == set(candidate.keys())
    assert set(baseline["dimensions"].keys()) == set(candidate["dimensions"].keys())

    for result in (baseline, candidate):
        assert result["suggested_grade"] in {"PASS", "FAIL", "REVIEW"}
        assert isinstance(result["justification_short"], str)
        assert 0 <= result["overall_score"] <= 1

        for value in result["dimensions"].values():
            assert value in {0.0, 0.5, 1.0}


def test_offline_comparison_persists_legacy_and_preprocessed_outputs():
    output = _run_node_scoring(enable_preprocessing_v2=True)["comparison"]

    assert output["selected_variant"] in {"legacy", "v2"}
    assert "dimensions" in output["legacy"]
    assert "dimensions" in output["preprocessed"]
    assert set(output["legacy"]["dimensions"].keys()) == {
        "core_idea",
        "conceptual_accuracy",
        "completeness",
        "memorization_risk",
    }
    assert set(output["preprocessed"]["dimensions"].keys()) == set(output["legacy"]["dimensions"].keys())
