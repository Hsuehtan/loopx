import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deltaJsonSchema } from "../src/codex.ts";
import { applyDelta } from "../src/state.ts";
import type { Goal, KernelState, TurnDelta } from "../src/types.ts";

function goal(): Goal {
  return {
    goal_id: "g1",
    objective: "objective",
    predicates: [
      { id: "p1", statement: "one", verify: { kind: "file_exists", path: "a" } },
      { id: "p2", statement: "two", verify: { kind: "file_exists", path: "b" } },
    ],
    policy: { max_turns: 5, max_idle_turns: 2 },
  };
}

function state(overrides: Partial<KernelState> = {}): KernelState {
  return {
    version: 1,
    goal_id: "g1",
    goal_hash: "h",
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

function delta(overrides: Partial<TurnDelta> = {}): TurnDelta {
  return {
    closed: [],
    new_todos: [],
    new_assumptions: [],
    proposed_amendment: null,
    note: "",
    ...overrides,
  };
}

test("the delta schema requires exactly the fields the kernel reads", () => {
  const schema = deltaJsonSchema() as { required: string[]; properties: Record<string, unknown>; additionalProperties: boolean };
  assert.deepEqual(schema.required.sort(), [
    "closed",
    "new_assumptions",
    "new_todos",
    "note",
    "proposed_amendment",
  ]);
  assert.equal(schema.additionalProperties, false);
});

test("the delta schema is emitted as strict JSON for codex --output-schema", () => {
  const round = JSON.parse(JSON.stringify(deltaJsonSchema()));
  assert.equal(round.type, "object");
});

test("a scoped todo is admitted and recorded against its predicate", () => {
  const s = state();
  const result = applyDelta(s, goal(), delta({
    new_todos: [{ id: "t1", title: "write a", done_when: "a exists", advances: "p1" }],
  }), []);
  assert.deepEqual(result.admitted, ["t1"]);
  assert.equal(s.todos[0].advances, "p1");
  assert.equal(s.todos[0].status, "open");
});

test("an unscoped todo is rejected, not repaired", () => {
  const s = state();
  const result = applyDelta(s, goal(), delta({
    new_todos: [{ id: "t1", title: "cleanup", done_when: "clean", advances: "p9" }],
  }), []);
  assert.deepEqual(result.admitted, []);
  assert.equal(result.rejected[0].kind, "todo_unscoped");
  assert.equal(s.todos.length, 0);
});

test("a verified predicate closes the open todos that advance it", () => {
  const s = state({ todos: [{ id: "t1", title: "x", done_when: "x", advances: "p1", status: "open" }] });
  applyDelta(s, goal(), delta(), ["p1"]);
  assert.equal(s.todos[0].status, "done");
  assert.deepEqual(s.verified_predicates, ["p1"]);
});

test("acceptance replaces the earlier snapshot instead of accumulating stale passes", () => {
  const s = state();
  applyDelta(s, goal(), delta(), ["p1"]);
  applyDelta(s, goal(), delta(), ["p1", "p2"]);
  assert.deepEqual(s.verified_predicates.sort(), ["p1", "p2"]);
  applyDelta(s, goal(), delta(), ["p2"]);
  assert.deepEqual(s.verified_predicates, ["p2"]);
});

test("an assumption without a real sha256 is refused", () => {
  const s = state();
  const result = applyDelta(s, goal(), delta({
    new_assumptions: [
      { id: "a1", statement: "vague", source: { kind: "file", path: "doc.md", sha256: "not-a-hash" } },
    ],
  }), []);
  assert.equal(result.rejected[0].kind, "assumption_invalid_source");
  assert.equal(s.assumptions.length, 0);
});

test("a valid assumption is recorded with its revision", () => {
  const s = state();
  const digest = "a".repeat(64);
  applyDelta(s, goal(), delta({
    new_assumptions: [{ id: "a1", statement: "doc says X", source: { kind: "file", path: "doc.md", sha256: digest } }],
  }), []);
  assert.equal(s.assumptions[0].source.sha256, digest);
});

test("duplicate todo ids from a confused turn are refused once", () => {
  const s = state({ todos: [{ id: "t1", title: "x", done_when: "x", advances: "p1", status: "open" }] });
  const result = applyDelta(s, goal(), delta({
    new_todos: [{ id: "t1", title: "again", done_when: "x", advances: "p1" }],
  }), []);
  assert.deepEqual(result.admitted, []);
  assert.equal(result.rejected[0].kind, "todo_duplicate_id");
});

test("init writes a frozen goal file whose recorded hash matches the file", async () => {
  const { GoalStore } = await import("../src/store.ts");
  const { goalFingerprint } = await import("../src/invariants.ts");
  const project = mkdtempSync(join(tmpdir(), "store-"));
  const store = new GoalStore(project, join(project, ".loopx"), "g1");
  const g = goal();
  const { goal_hash } = store.initGoal(g);
  assert.equal(goal_hash, goalFingerprint(g));
  const written = JSON.parse(readFileSync(store.goalPath, "utf8"));
  assert.equal(written.goal_hash, goal_hash);
  assert.equal(written.objective, g.objective);
});

test("state round-trips through the store", async () => {
  const { GoalStore } = await import("../src/store.ts");
  const project = mkdtempSync(join(tmpdir(), "store-"));
  const store = new GoalStore(project, join(project, ".loopx"), "g1");
  store.initGoal(goal());
  const s = store.readState();
  s.turn_count = 4;
  writeFileSync(join(project, "marker"), "ignored");
  store.writeState(s);
  assert.equal(store.readState().turn_count, 4);
});
