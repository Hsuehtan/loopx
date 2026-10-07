"""Registered-source adapters for the typed interaction context owner.

Read source bodies, not summaries or displayed commands. Selection, fulfillment
and dependent-work policy remain in TypeScript; this module grants no effects.
"""
from __future__ import annotations

from hashlib import sha256
from pathlib import Path
from typing import Any

from ...history import load_registry
from ..effect_runtime import effect_runtime_result
from ..goals.acceptance import inspect_goal_acceptance
from ..goals.state_resolution import resolve_goal_state
from ..todos.list_readback import list_goal_todos


def _source_content(read, *, registry_path, runtime_root, goal_id, todo_id):
    source = read.get("source")
    if source == "goal_state":
        _goal, _project, state_file = resolve_goal_state(
            registry=load_registry(registry_path), goal_id=goal_id,
            project_override=None, state_file_override=None)
        text = state_file.read_text(encoding="utf-8")
        return {"state_file": str(state_file), "text": text,
            "revision": "sha256:" + sha256(text.encode("utf-8")).hexdigest()}
    if source == "goal_acceptance":
        return inspect_goal_acceptance(registry_path=registry_path, goal_id=goal_id,
            runtime_root=str(runtime_root))
    if source == "selected_todo":
        return list_goal_todos(registry_path=registry_path, goal_id=goal_id,
            todo_id=todo_id, runtime_root_arg=str(runtime_root))
    raise ValueError("unregistered work context source")


def _user_context(*, registry_path, runtime_root, goal_id, agent_id):
    # Reuse the canonical scope owner (global/blocks_agent/bound_agent and
    # legacy scoping). Exact reads restore full text after scope filtering.
    inventory = list_goal_todos(registry_path=registry_path, goal_id=goal_id,
        role="user", status="open", agent_id=agent_id,
        runtime_root_arg=str(runtime_root))
    records = []
    revision = (inventory.get("authority_read") or {}).get("provider_revision")
    for row in inventory.get("todos", []):
        detail = list_goal_todos(registry_path=registry_path, goal_id=goal_id,
            role="user", status="open", agent_id=agent_id, todo_id=row["todo_id"],
            runtime_root_arg=str(runtime_root))
        if not detail.get("matched") or detail.get("ambiguous"):
            raise ValueError("User context changed during source read; rerun guard")
        if (detail.get("authority_read") or {}).get("provider_revision") != revision:
            raise ValueError("User context source revision changed; rerun guard")
        records.append(detail["todo"])
    return {"source": inventory["source"], "authority_read": inventory.get("authority_read"),
        "todos": records}


def attach_work_context(payload: dict[str, Any], *, registry_path: Path,
                        runtime_root: Path, hook_dispatch: dict[str, Any] | None) -> None:
    interaction = payload.get("interaction_contract")
    if not isinstance(interaction, dict):
        return
    channel = interaction.get("agent_channel") or {}
    reads = channel.get("required_reads") or []
    goal_id = payload.get("goal_id")
    agent_id = (payload.get("agent_identity") or {}).get("agent_id")
    if not goal_id:
        return
    plan = effect_runtime_result("work_item.context.plan", {"packet": payload})
    results = [dict(item) for item in (hook_dispatch or {}).get("contexts", [])]
    for read in reads:
        if read.get("source") not in {"goal_state", "goal_acceptance", "selected_todo"}:
            continue
        result = {"command": read["command"]}
        try:
            result["content"] = _source_content(read, registry_path=registry_path,
                runtime_root=runtime_root, goal_id=goal_id, todo_id=plan.get("todo_id"))
        except (OSError, ValueError, RuntimeError):
            result["error_code"] = "context_source_unavailable"
        results.append(result)
    users = None
    if agent_id and plan.get("read_user_todos"):
        try:
            users = _user_context(registry_path=registry_path, runtime_root=runtime_root,
                goal_id=goal_id, agent_id=agent_id)
        except (OSError, ValueError, RuntimeError):
            users = {"error_code": "context_source_unavailable"}
    projected = effect_runtime_result("work_item.context.project", {
        "required_reads": reads, "source_results": results,
        "selected_todo": plan.get("selected_todo"), "user_todos": users,
        "hook_dispatch": hook_dispatch,
    }, large_local_snapshot=True)
    channel.update(projected)
    if not projected["work_context"]["complete"]:
        channel["delivery_allowed"] = False
    # Bodies have one carrier. Historical pointers are not another instruction
    # to execute the same read; explicit diagnostics retain hook metadata only.
    payload.pop("required_reads", None)
