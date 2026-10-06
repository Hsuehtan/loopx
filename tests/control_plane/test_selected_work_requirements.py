"""Default product heartbeat reads the whole Goal and current work from their owners."""
from __future__ import annotations

import json
import os
import re
import shlex
import subprocess
import sys
from pathlib import Path

import pytest

from canonical_authority_fixture import initialize_canonical_authority, isolate_sqlite_runtime
from loopx.control_plane.coordination.runtime_shadow import build_todo_runtime_shadow_projection
from loopx.control_plane.testing.canary_harness import run_json_cli_result, write_fixture_registry
from loopx.control_plane.todos.active_state_todo_parser import parse_todo_source
from loopx.control_plane.todos.goal_todo_projection import retained_todo_summary_fields
from loopx.control_plane.turn_driver.codex_cli import _prompt
from loopx.control_plane.turn_driver.driver import build_loopx_turn_plan
from loopx.control_plane.turn_driver.executor import build_loopx_turn_host_request
from loopx.control_plane.turn_driver.host_candidate import extract_turn_authority, render_prompt


@pytest.mark.parametrize("provider", ["legacy", "file", "sqlite"])
def test_current_work_requirements_reach_real_guard_and_host_without_display_loss(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, provider: str,
) -> None:
    if provider == "sqlite":
        isolate_sqlite_runtime(tmp_path, monkeypatch)
    runtime, registry, state = tmp_path / "runtime", tmp_path / "registry.json", tmp_path / "state's requirements.md"
    work = ("Repair the cursor boundary. " + "Preserve the existing query contract. " * 24 +
            "Acceptance: no missing or repeated boundary records; retain cancellation and add regression coverage.")
    goal_requirements = ("---\nstatus: active\n---\n# Goal\n## Objective\nDeliver a compatible query service.\n"
        "## Acceptance\n" + "Retain all query guarantees. " * 24 + "Do not omit records in any query mode.\n"
        "## Non-goals\nNo unrelated migration.\n## Stop Conditions\nStop before an unauthorized deployment.\n\n")
    state.write_text(goal_requirements +
        "## Agent Todo\n- [ ] [P2] Unrelated peer work must not replace the selected requirements.\n"
        "  <!-- loopx:todo todo_id=todo_peer_work status=open task_class=advancement_task claimed_by=agent-b -->\n"
        f"- [ ] [P1] {work}\n"
        "  <!-- loopx:todo todo_id=todo_cursor_work status=open task_class=advancement_task claimed_by=agent-a -->\n")
    write_fixture_registry(project=tmp_path, runtime_root=runtime, registry_path=registry,
        goal_id="requirements-goal", domain="requirements", adapter_kind="generic_project_goal_v0",
        state_file=str(state), registered_agents=["agent-a", "agent-b"], quota_allowed_slots=None)
    expected = "[P1] " + work
    if provider != "legacy":
        goal = json.loads(registry.read_text())["goals"][0]
        fields, _archived, _sections = parse_todo_source(state.read_text(), goal=goal, state_path=state)
        full_items = retained_todo_summary_fields(fields["agent"], rollout_events=[])["agent_todos"]["items"]
        snapshot = build_todo_runtime_shadow_projection(
            goal_id="requirements-goal", todos=full_items, handoff_mode="soft_claim")
        initialize_canonical_authority(runtime, "requirements-goal", snapshot,
            state_path=state, provider=provider)
        state.write_text(goal_requirements + "## Agent Todo\n- [ ] Stale display: do only an easier check.\n")
        code, inspected = run_json_cli_result("goal-acceptance", "inspect", "--goal-id", "requirements-goal",
            registry_path=registry, runtime_root=runtime)
        assert code == 0, inspected
        document = tmp_path / "acceptance.json"
        document.write_text(json.dumps({"scope": {"kind": "selected_work", "todo_ids": ["todo_cursor_work"]},
            "objective": "Deliver every query guarantee. " * 24,
            "non_goals": ["No unrelated migration."], "criteria": [{"id": "compatibility",
                "description": "Preserve all modes. " * 24 + "Retain the last query mode.",
                "validation_argv": [sys.executable, "-c", "pass"]}],
            "bindings": [{"todo_id": "todo_cursor_work", "criterion_ids": ["compatibility"]}]}))
        code, configured = run_json_cli_result("goal-acceptance", "configure", "--goal-id", "requirements-goal",
            "--document", str(document), "--expected-provider-revision", inspected["provider_revision"],
            "--execute", registry_path=registry, runtime_root=runtime)
        assert code == 0, configured

    def guard(*extra: str) -> dict:
        code, packet = run_json_cli_result("quota", "should-run", "--goal-id", "requirements-goal",
            "--agent-id", "agent-a", "--scan-path", str(tmp_path), *extra,
            registry_path=registry, runtime_root=runtime)
        assert code == 0, packet
        assert packet["should_run"] is True, packet.get("reason")
        return packet

    before = state.read_bytes()
    # Run the actual default product prompt's guard: no capture/envelope opt-in.
    code, generated = run_json_cli_result("heartbeat-prompt", "--goal-id", "requirements-goal",
        "--agent-id", "agent-a", "--codex-app", "--cli-bin", str(Path(sys.executable).parent / "loopx"),
        registry_path=registry, runtime_root=runtime)
    assert code == 0 and generated["ok"], generated
    body = generated["task_body"]
    assert "interaction_contract.agent_channel.required_reads" in body
    script = re.search(r"```sh\n(.*?)\n```", body, re.S).group(1)
    assert "--turn-envelope" not in script and "--decision-output-root" not in script
    env = {**os.environ, "LOOPX_REGISTRY": str(registry)}
    result = subprocess.run(["sh", "-c", script.replace("<current_time_iso>", "requirements-default-wake")],
        cwd=tmp_path, env=env, capture_output=True, text=True, check=True)
    full = json.loads(result.stdout)
    assert full["should_run"] is True, full.get("reason")
    reads = full["interaction_contract"]["agent_channel"]["required_reads"]
    assert reads == full["interaction_contract"]["cli_channel"]["required_reads"]
    assert [read["source"] for read in reads] == (["goal_state", "selected_todo"] if provider == "legacy"
        else ["goal_state", "goal_acceptance", "selected_todo"])
    goal_read = subprocess.run(shlex.split(reads[0]["command"]), capture_output=True, text=True, check=True)
    assert goal_requirements in goal_read.stdout
    assert "Stop before an unauthorized deployment." in goal_read.stdout
    if provider != "legacy":
        acceptance = subprocess.run([sys.executable, "-m", "loopx.cli", *shlex.split(reads[1]["command"])[1:]],
            capture_output=True, text=True, check=True)
        contract = json.loads(acceptance.stdout)["goal_acceptance_contract"]
        assert contract["criteria"][0]["description"].endswith("Retain the last query mode.")
        assert len(contract["objective"]) > 500
    assert full["selected_todo"]["todo_id"] == "todo_cursor_work"
    assert full["selected_todo"]["text"] != expected  # Deliberately bounded hot view.
    envelope = guard("--turn-envelope")
    assert envelope["required_reads"] == reads
    selected = envelope["action"]["selected_todo"]
    assert selected["todo_id"] == "todo_cursor_work"
    read = next(item for item in envelope["required_reads"] if item.get("source") == "selected_todo")
    tokens = shlex.split(read["command"])
    assert tokens[tokens.index("--registry") + 1] == str(registry)
    assert tokens[tokens.index("--runtime-root") + 1] == str(runtime)
    assert tokens[tokens.index("--todo-id") + 1] == "todo_cursor_work"

    def read_detail() -> dict:
        result = subprocess.run([sys.executable, "-m", "loopx.cli", *tokens[1:]],
            capture_output=True, text=True, check=True)
        return json.loads(result.stdout)

    detail = read_detail()
    assert detail["ok"] and detail["matched"] and detail["todo_count"] == 1
    assert detail["todo"]["text"] == expected
    assert detail["todo"]["claimed_by"] == "agent-a"
    assert envelope["action_signature"]["matches"] is True
    assert state.read_bytes() == before

    plan = build_loopx_turn_plan(envelope, host="codex-cli", execution_mode="isolated-headless",
        turn_instance_id="requirements-synthetic-turn")
    request = build_loopx_turn_host_request(plan)
    assert read["command"] in _prompt(request)
    assert "Complete required_reads before primary_action" in _prompt(request)
    authority = extract_turn_authority(request)
    assert authority["selected_todo"]["todo_id"] == "todo_cursor_work"
    assert read in authority["required_reads"]
    assert read["command"] in render_prompt(authority)

    # A fresh CLI process must recover current requirements from the same owner,
    # including a changed last condition, rather than reusing a cached summary.
    replacement = expected.replace("retain cancellation", "retain cancellation and timeout behavior")
    code, update = run_json_cli_result("todo", "update", "--goal-id", "requirements-goal",
        "--todo-id", "todo_cursor_work", "--agent-id", "agent-a", "--text", replacement,
        registry_path=registry, runtime_root=runtime)
    assert code == 0, json.dumps(update)
    assert read_detail()["todo"]["text"] == replacement
    fresh = guard()
    if provider == "legacy":
        assert fresh["selected_todo"]["todo_id"] == "todo_cursor_work"
    else:
        # Updating a bound task makes its acceptance binding stale. Re-guarding
        # must respect that owner rather than readmission via the full text.
        assert fresh.get("selected_todo") is None
        assert not any(read.get("source") == "selected_todo"
            for read in fresh["interaction_contract"]["agent_channel"].get("required_reads", []))
    missing_tokens = ["todo_missing" if token == "todo_cursor_work" else token for token in tokens]
    missing = subprocess.run([sys.executable, "-m", "loopx.cli", *missing_tokens[1:]],
        capture_output=True, text=True, check=True)
    assert json.loads(missing.stdout)["not_found"] is True
    # Source reads are fresh, not snapshots of the earlier guard. Failure is
    # visible to the host and must not be mistaken for successful consumption.
    state.write_text(state.read_text().replace("Do not omit records in any query mode.",
        "Do not omit records in any query mode, including archived queries."))
    current_goal = subprocess.run(shlex.split(reads[0]["command"]), capture_output=True, text=True, check=True)
    assert "including archived queries." in current_goal.stdout
    saved = state.with_suffix(".saved")
    state.rename(saved)
    try:
        failed = subprocess.run(shlex.split(reads[0]["command"]), capture_output=True, text=True)
        assert failed.returncode != 0 and not failed.stdout
    finally:
        saved.rename(state)
