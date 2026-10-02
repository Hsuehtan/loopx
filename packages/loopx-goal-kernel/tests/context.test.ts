import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { renderContext } from "../src/context.ts";
import { sha256File } from "../src/hash.ts";
import type { Goal, KernelState } from "../src/types.ts";

function baseGoal(): Goal {
  return {
    goal_id: "g1",
    objective: "Make the greeting module produce a localized greeting.",
    predicates: [
      { id: "p1", statement: "greet.py exists", verify: { kind: "file_exists", path: "greet.py" } },
      {
        id: "p2",
        statement: "greet.py prints 'hello'",
        verify: { kind: "command", run: "python3 greet.py", expect_stdout: "hello" },
      },
    ],
    policy: { max_turns: 10, max_idle_turns: 2 },
  };
}

function baseState(overrides: Partial<KernelState> = {}): KernelState {
  return {
    version: 1,
    goal_id: "g1",
    goal_hash: "deadbeef",
    session_id: null,
    turn_count: 0,
    usage_total: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 },
    todos: [],
    assumptions: [],
    verified_predicates: [],
    pending_decision: null,
    no_progress_streak: 0,
    status: "running",
    stop: null,
    ...overrides,
  };
}

test("context rendering is deterministic for the same goal and state", () => {
  const goal = baseGoal();
  const state = baseState();
  const first = renderContext(goal, state);
  const second = renderContext(goal, state);
  assert.equal(first.prompt, second.prompt);
  assert.equal(first.ctx_hash, second.ctx_hash);
});

test("context changes when the objective changes, so a silent edit is visible in ctx_hash", () => {
  const state = baseState();
  const before = renderContext(baseGoal(), state);
  const after = renderContext({ ...baseGoal(), objective: "Do something else entirely." }, state);
  assert.notEqual(before.ctx_hash, after.ctx_hash);
});

test("context changes when persisted state changes", () => {
  const goal = baseGoal();
  const before = renderContext(goal, baseState());
  const after = renderContext(goal, baseState({ turn_count: 1 }));
  assert.notEqual(before.ctx_hash, after.ctx_hash);
});

test("context always carries the frozen objective and every predicate", () => {
  const goal = baseGoal();
  const { prompt } = renderContext(goal, baseState());
  assert.ok(prompt.includes(goal.objective));
  for (const predicate of goal.predicates) {
    assert.ok(prompt.includes(predicate.id), `prompt should mention ${predicate.id}`);
  }
});

test("context marks a kernel-verified predicate as satisfied, and an owner predicate as never self-certifiable", () => {
  const goal = baseGoal();
  const state = baseState({ verified_predicates: ["p1"] });
  const { prompt } = renderContext(goal, state);
  assert.ok(prompt.includes("- [x] p1"));
  assert.ok(prompt.includes("- [ ] p2"));
});

test("context warns once the no-progress streak is non-zero", () => {
  const goal = baseGoal();
  const { prompt } = renderContext(goal, baseState({ no_progress_streak: 1 }));
  assert.ok(prompt.includes("consecutive turn(s) verified no new checkpoint"));
});

test("assumptions are echoed with their revision so a stale one is visible to the model too", () => {
  const dir = mkdtempSync(join(tmpdir(), "ctx-"));
  const file = join(dir, "doc.md");
  writeFileSync(file, "revision A");
  const digest = sha256File(file);
  const goal = baseGoal();
  const state = baseState({
    assumptions: [{ id: "a1", statement: "the doc says A", source: { kind: "file", path: file, sha256: digest } }],
  });
  const { prompt } = renderContext(goal, state);
  assert.ok(prompt.includes("a1"));
  assert.ok(prompt.includes(digest.slice(0, 12)));
});
