"""Lossless selected detail is distinct from bounded list summaries."""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest
from canonical_authority_fixture import initialize_canonical_authority, isolate_sqlite_runtime

from loopx.control_plane.coordination.runtime_shadow import build_todo_runtime_shadow_projection
from loopx.todos import list_goal_todos
from tests.control_plane.test_cli_output_budget import AGENT_IDS, GOAL_ID, SCENARIOS, _write_fixture

REPO = Path(__file__).resolve().parents[2]
BODY = "Preserve all original constraints. " * 80 + "TAIL: do not publish or change the acceptance scope."
SOURCE_BODY = "[P0] " + BODY
TODO = "todo_fixture_000"


def cli(registry, runtime, *flags, output_format="json"):
    result = subprocess.run(
        [sys.executable, "-m", "loopx.cli", "--registry", str(registry),
         "--runtime-root", str(runtime), "--format", output_format, "todo", "list",
         "--goal-id", GOAL_ID, *flags],
        cwd=REPO, capture_output=True, text=True, timeout=60,
    )
    return result.returncode, json.loads(result.stdout) if output_format == "json" else result.stdout


def string_leaves(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for child in value.values():
            yield from string_leaves(child)
    elif isinstance(value, list):
        for child in value:
            yield from string_leaves(child)


@pytest.mark.parametrize("provider", ["legacy", "file", "sqlite"])
def test_detail_retains_one_complete_body_and_current_source(tmp_path, monkeypatch, provider):
    isolate_sqlite_runtime(tmp_path, monkeypatch)
    project, runtime, registry, state = _write_fixture(tmp_path, SCENARIOS[0])
    state.write_text(state.read_text().replace(
        "Validate public fixture lane 00 without reading archival detail.", BODY,
    ))
    if provider != "legacy":
        rows = list_goal_todos(registry_path=registry, goal_id=GOAL_ID, todo_id=TODO)["todos"]
        projection = build_todo_runtime_shadow_projection(
            goal_id=GOAL_ID, handoff_mode="legacy", leases=[], todos=rows,
        )
        initialize_canonical_authority(runtime, GOAL_ID, projection, state_path=state, provider=provider)
        # Canonical source remains authoritative when display text is lost.
        state.write_text(state.read_text().replace(BODY, "Stale display prefix"))
    before = state.read_bytes()
    rc, full = cli(registry, runtime, "--todo-id", TODO, "--agent-id", AGENT_IDS[0])
    assert rc == 0
    rc, detail = cli(registry, runtime, "--todo-id", TODO, "--agent-id", AGENT_IDS[0], "--compact-detail")
    assert rc == 0, detail
    assert detail["todo"] == full["todo"]
    assert detail["todo"]["text"] == SOURCE_BODY
    assert sum(text == SOURCE_BODY for text in string_leaves(detail)) == 1
    assert detail["relations"] == full["relations"]
    assert detail["source"] == full["source"]
    assert detail.get("authority_read") == full.get("authority_read")
    assert not {"todos", "agent_todos", "user_todos"}.intersection(detail)
    rc, markdown = cli(registry, runtime, "--todo-id", TODO, "--compact-detail", output_format="markdown")
    assert rc == 0 and markdown.count(SOURCE_BODY) == 1
    assert "TAIL:" in markdown and '"source_complete": true' in markdown
    assert state.read_bytes() == before
    rc, repeated = cli(registry, runtime, "--todo-id", TODO, "--agent-id", AGENT_IDS[0])
    assert rc == 0 and repeated == full
    rc, thin = cli(registry, runtime, "--todo-id", TODO, "--thin")
    assert rc == 0 and "TAIL:" not in thin["todo"]["text"]
    rc, missing = cli(registry, runtime, "--todo-id", "todo_missing", "--compact-detail")
    assert rc == 0 and missing["todo"] is None and missing["not_found"]
    rc, other_lane = cli(registry, runtime, "--todo-id", TODO, "--agent-id", "codex-other", "--compact-detail")
    assert rc == 0 and other_lane["todo"] is None and other_lane["not_found"]
    if provider == "file":
        snapshot = next((runtime / "authority/file-v0").glob("authority-store-*.json"))
        original = snapshot.read_bytes()
        try:
            snapshot.write_text("{unavailable source")
            rc, unavailable = cli(registry, runtime, "--todo-id", TODO, "--compact-detail")
            assert rc == 1 and not unavailable["ok"]
            assert not unavailable.get("todo")
            assert SOURCE_BODY not in json.dumps(unavailable)
        finally:
            snapshot.write_bytes(original)
        rc, restored = cli(registry, runtime, "--todo-id", TODO, "--compact-detail")
        assert rc == 0 and restored["todo"]["text"] == SOURCE_BODY


@pytest.mark.parametrize("flags", [[], ["--todo-id", TODO, "--thin"]])
def test_detail_refuses_missing_identity_or_thin_combination(tmp_path, flags):
    _, runtime, registry, state = _write_fixture(tmp_path, SCENARIOS[0])
    before = state.read_bytes()
    rc, rejected = cli(registry, runtime, *flags, "--compact-detail")
    assert rc == 1 and not rejected["ok"]
    assert "compact-detail" in rejected["error"]
    assert state.read_bytes() == before
