import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GoalKernel } from "../src/kernel.ts";
import { GoalStore } from "../src/store.ts";
import { sha256File } from "../src/hash.ts";
import type { Goal, TurnDelta, Usage } from "../src/types.ts";

const ZERO: Usage = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 };

function goal(overrides: Partial<Goal> = {}): Goal {
  return {
    goal_id: "g1",
    objective: "Create greeting.py that prints hello.",
    predicates: [
      { id: "p1", statement: "greeting.py exists", verify: { kind: "file_exists", path: "greeting.py" } },
      {
        id: "p2",
        statement: "greeting.py prints hello",
        verify: { kind: "command", run: "python3 greeting.py", expect_stdout: "hello" },
      },
    ],
    policy: { max_turns: 10, max_idle_turns: 2 },
    ...overrides,
  };
}

interface Harness {
  project: string;
  store: GoalStore;
  kernel: GoalKernel;
  states: Array<{ prompt: string; sessionId: string | null }>;
}

/**
 * A scripted stand-in for Codex. It replaces only the model call; every gate,
 * hash, verification and stop decision below runs the real kernel code.
 */
function harness(script: Array<TurnDelta | ((input: { project: string; turn: number }) => TurnDelta)>): Harness {
  const project = mkdtempSync(join(tmpdir(), "kernel-"));
  const store = new GoalStore(project, join(project, ".loopx"), "g1");
  store.initGoal(goal());
  const states: Array<{ prompt: string; sessionId: string | null }> = [];
  let turn = 0;
  const kernel = new GoalKernel(store, {
    projectRoot: project,
    runTurn: async (input) => {
      states.push({ prompt: input.prompt, sessionId: input.sessionId });
      const entry = script[Math.min(turn, script.length - 1)];
      turn += 1;
      const delta = typeof entry === "function" ? entry({ project, turn }) : entry;
      return {
        delta,
        sessionId: input.sessionId ?? "session-1",
        sessionReused: input.sessionId !== null,
        usage: { input_tokens: 100, cached_input_tokens: 50, output_tokens: 20 },
      };
    },
  });
  return { project, store, kernel, states };
}

const IDLE: TurnDelta = {
  closed: [],
  new_todos: [],
  new_assumptions: [],
  proposed_amendment: null,
  note: "nothing to do",
};

test("a turn that claims a predicate the workspace does not satisfy is not credited", async () => {
  const h = harness([{ ...IDLE, closed: ["p1"] }]);
  const result = await h.kernel.runOneTurn();
  assert.deepEqual(result.verified, []);
  assert.deepEqual(result.claimed, ["p1"]);
  assert.equal(result.progress, false);
  const state = h.store.readState();
  assert.deepEqual(state.verified_predicates, []);
});

test("a turn that actually satisfies the predicate is credited by independent verification", async () => {
  const h = harness([
    (input) => {
      writeFileSync(join(input.project, "greeting.py"), "print('hello')\n");
      return { ...IDLE, closed: ["p1", "p2"], note: "wrote greeting.py" };
    },
  ]);
  const result = await h.kernel.runOneTurn();
  assert.deepEqual(result.verified.sort(), ["p1", "p2"]);
  assert.equal(result.progress, true);
});

test("a broken claim of a command predicate is rejected even when the file exists", async () => {
  const h = harness([
    (input) => {
      writeFileSync(join(input.project, "greeting.py"), "print('goodbye')\n");
      return { ...IDLE, closed: ["p1", "p2"] };
    },
  ]);
  const result = await h.kernel.runOneTurn();
  assert.deepEqual(result.verified, ["p1"]);
  assert.ok(result.rejected.some((r) => r.kind === "unverified_claim"));
});

test("a fully verified goal completes and stops the loop", async () => {
  const h = harness([
    (input) => {
      writeFileSync(join(input.project, "greeting.py"), "print('hello')\n");
      return { ...IDLE, closed: ["p1", "p2"] };
    },
  ]);
  const first = await h.kernel.runOneTurn();
  assert.equal(first.stop?.reason, "goal_complete");
  assert.equal(h.store.readState().status, "done");
});

test("the no-progress fuse stops a loop that keeps spending without moving", async () => {
  const h = harness([IDLE, IDLE, IDLE, IDLE]);
  const one = await h.kernel.runOneTurn();
  assert.equal(one.stop, null);
  const two = await h.kernel.runOneTurn();
  assert.equal(two.stop?.reason, "no_progress");
  assert.equal(h.store.readState().status, "stopped");
});

test("a stale assumption stops the loop before the next turn spends anything", async () => {
  const h = harness([IDLE]);
  const doc = join(h.project, "spec.md");
  writeFileSync(doc, "revision one");
  const store = h.store;
  const state = store.readState();
  state.todos.push({ id: "t1", title: "x", done_when: "x", advances: "p1", status: "open" });
  state.assumptions.push({
    id: "a1",
    statement: "spec says one",
    source: { kind: "file", path: doc, sha256: sha256File(doc) },
  });
  store.writeState(state);

  // The world moves underneath the run.
  writeFileSync(doc, "revision two");

  const result = await h.kernel.runOneTurn();
  assert.equal(result.stop?.reason, "stale_assumption");
  assert.equal(h.states.length, 0, "no model call should happen once the gate fails");
});

test("an unscoped todo already in state blocks the run before any spend", async () => {
  const h = harness([IDLE]);
  const state = h.store.readState();
  state.todos.push({ id: "t1", title: "refactor", done_when: "nicer", advances: "", status: "open" });
  h.store.writeState(state);
  const result = await h.kernel.runOneTurn();
  assert.equal(result.stop?.reason, "unscoped_todo");
  assert.equal(h.states.length, 0);
});

test("editing the frozen goal file outside the kernel is detected as a hash mismatch", async () => {
  const h = harness([IDLE]);
  const written = JSON.parse(readFileSync(h.store.goalPath, "utf8"));
  writeFileSync(h.store.goalPath, JSON.stringify({ ...written, objective: "Secretly different objective." }));
  const result = await h.kernel.runOneTurn();
  assert.equal(result.stop?.reason, "goal_hash_mismatch");
  assert.equal(h.states.length, 0);
});

test("the objective cannot change silently: a proposed amendment stops the run for the owner", async () => {
  const h = harness([
    { ...IDLE, proposed_amendment: { objective: "Actually, just delete everything.", reason: "simpler" } },
  ]);
  const result = await h.kernel.runOneTurn();
  assert.equal(result.stop?.reason, "goal_amendment_required");
  const state = h.store.readState();
  assert.ok(state.pending_decision, "the proposal must be recorded, not applied");
  // The frozen goal is untouched.
  assert.equal(h.store.readGoal().objective, "Create greeting.py that prints hello.");
});

test("turn budget is enforced", async () => {
  const h = harness([IDLE]);
  h.store.initGoal(goal({ policy: { max_turns: 1, max_idle_turns: 9 } }));
  await h.kernel.runOneTurn();
  const second = await h.kernel.runOneTurn();
  assert.equal(second.stop?.reason, "budget_exhausted");
});

test("a resumed turn reuses the session id from state", async () => {
  const h = harness([IDLE, IDLE]);
  h.store.initGoal(goal({ policy: { max_turns: 10, max_idle_turns: 9 } }));
  await h.kernel.runOneTurn();
  await h.kernel.runOneTurn();
  assert.equal(h.states[0].sessionId, null);
  assert.equal(h.states[1].sessionId, "session-1");
});

test("the journal records a receipt per turn with the context hash and verification result", async () => {
  const h = harness([
    (input) => {
      writeFileSync(join(input.project, "greeting.py"), "print('hello')\n");
      return { ...IDLE, closed: ["p1", "p2"] };
    },
  ]);
  await h.kernel.runOneTurn();
  const receipts = h.store.readJournal();
  const turn = receipts.find((r) => "ctx_hash" in r);
  assert.ok(turn);
  assert.ok((turn as { ctx_hash: string }).ctx_hash.length === 64);
  assert.ok((turn as { verified: Array<{ ok: boolean }> }).verified.every((v) => v.ok));
});

test("the loop is restartable: a fresh kernel instance continues from state alone", async () => {
  const h = harness([IDLE, IDLE, IDLE]);
  h.store.initGoal(goal({ policy: { max_turns: 10, max_idle_turns: 9 } }));
  await h.kernel.runOneTurn();
  // Simulate a process restart: brand new kernel over the same directory.
  const restarted = new GoalKernel(h.store, {
    projectRoot: h.project,
    runTurn: async (input) => ({
      delta: IDLE,
      sessionId: input.sessionId ?? "session-1",
      sessionReused: input.sessionId !== null,
      usage: ZERO,
    }),
  });
  const result = await restarted.runOneTurn();
  assert.equal(result.turn_index, 2);
  assert.equal(h.store.readState().turn_count, 2);
});

test("VIEW.md is a deterministic projection of goal and state", async () => {
  const h = harness([IDLE]);
  await h.kernel.runOneTurn();
  const view = readFileSync(h.store.viewPath, "utf8");
  assert.ok(view.includes("Create greeting.py that prints hello."));
  assert.ok(view.includes("p1"));
  assert.ok(view.includes("turns spent: 1"));
});
