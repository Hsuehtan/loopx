import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  checkAssumptions,
  checkBudget,
  checkInvariants,
  checkProgress,
  checkTodoScoping,
  isGoalComplete,
} from "../src/invariants.ts";
import { sha256File } from "../src/hash.ts";
import type { Goal, KernelState } from "../src/types.ts";

function goal(): Goal {
  return {
    goal_id: "g1",
    objective: "objective",
    predicates: [{ id: "p1", statement: "ok", verify: { kind: "file_exists", path: "x" } }],
    policy: { max_turns: 3, max_idle_turns: 2 },
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

test("a todo that advances no declared predicate is refused", () => {
  const violations = checkTodoScoping(goal(), [
    { id: "t1", title: "refactor the world", done_when: "looks nicer", advances: "", status: "open" },
  ]);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].reason, "unscoped_todo");
});

test("a todo advancing an undeclared predicate is refused", () => {
  const violations = checkTodoScoping(goal(), [
    { id: "t1", title: "side quest", done_when: "done", advances: "p99", status: "open" },
  ]);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].reason, "unscoped_todo");
});

test("a completed todo does not need to stay in scope", () => {
  const violations = checkTodoScoping(goal(), [
    { id: "t1", title: "old work", done_when: "done", advances: "", status: "done" },
  ]);
  assert.deepEqual(violations, []);
});

test("duplicate todo ids are refused", () => {
  const violations = checkTodoScoping(goal(), [
    { id: "t1", title: "a", done_when: "a", advances: "p1", status: "open" },
    { id: "t1", title: "b", done_when: "b", advances: "p1", status: "open" },
  ]);
  assert.equal(violations.length, 1);
});

test("an assumption whose file revision changed is a stale-assumption violation", () => {
  const dir = mkdtempSync(join(tmpdir(), "inv-"));
  const doc = join(dir, "spec.md");
  writeFileSync(doc, "revision one");
  const assumptions = [
    { id: "a1", statement: "spec says one", source: { kind: "file" as const, path: doc, sha256: sha256File(doc) } },
  ];
  assert.deepEqual(checkAssumptions(dir, assumptions).violations, []);

  writeFileSync(doc, "revision two");
  const report = checkAssumptions(dir, assumptions);
  assert.equal(report.violations.length, 1);
  assert.equal(report.violations[0].reason, "stale_assumption");
  assert.deepEqual(report.stale_assumptions, ["a1"]);
});

test("an assumption whose file disappeared fails closed", () => {
  const dir = mkdtempSync(join(tmpdir(), "inv-"));
  const report = checkAssumptions(dir, [
    { id: "a1", statement: "gone", source: { kind: "file", path: join(dir, "nope.md"), sha256: "0".repeat(64) } },
  ]);
  assert.equal(report.violations[0].reason, "stale_assumption");
});

test("budget exhaustion is a violation at the exact limit", () => {
  assert.deepEqual(checkBudget(goal(), state({ turn_count: 2 })), []);
  assert.equal(checkBudget(goal(), state({ turn_count: 3 }))[0].reason, "budget_exhausted");
});

test("the no-progress fuse fires at the configured streak", () => {
  assert.deepEqual(checkProgress(goal(), state({ no_progress_streak: 1 })), []);
  assert.equal(checkProgress(goal(), state({ no_progress_streak: 2 }))[0].reason, "no_progress");
});

test("checkInvariants reports every violation, not only the first", () => {
  const dir = mkdtempSync(join(tmpdir(), "inv-"));
  const report = checkInvariants(
    goal(),
    state({
      turn_count: 3,
      no_progress_streak: 2,
      todos: [{ id: "t1", title: "x", done_when: "x", advances: "", status: "open" }],
    }),
    dir,
  );
  assert.equal(report.ok, false);
  const reasons = report.violations.map((v) => v.reason).sort();
  assert.deepEqual(reasons, ["budget_exhausted", "no_progress", "unscoped_todo"]);
});

test("completion follows kernel-verified predicates only, never the todo list", () => {
  const g = goal();
  // A todo marked done by anything other than verification must not complete the goal.
  const claimed = state({
    todos: [{ id: "t1", title: "x", done_when: "x", advances: "p1", status: "done" }],
  });
  assert.equal(isGoalComplete(g, claimed), false);
  assert.equal(isGoalComplete(g, state({ verified_predicates: ["p1"] })), true);
});
