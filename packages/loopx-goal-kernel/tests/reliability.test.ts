import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GoalKernel } from "../src/kernel.ts";
import { GoalStore } from "../src/store.ts";
import type { Goal, TurnDelta } from "../src/types.ts";

const idle: TurnDelta = {
  closed: [], new_todos: [], new_assumptions: [], proposed_amendment: null, note: "",
};
const spec: Goal = {
  goal_id: "g", objective: "Create a and b and keep both present.",
  predicates: ["a", "b"].map(id => ({ id, statement: `${id} exists`, verify: { kind: "file_exists", path: id } })),
  policy: { max_turns: 10, max_idle_turns: 2 },
};

function harness(t: test.TestContext, step: (project: string, turn: number, prompt: string) => TurnDelta, goal = spec) {
  const project = mkdtempSync(join(tmpdir(), "gk-reliability-"));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  const store = new GoalStore(project, join(project, ".loopx"), "g");
  store.initGoal(goal);
  let calls = 0;
  const options = {
    projectRoot: project,
    runTurn: async (input: { prompt: string; sessionId: string | null }) => ({
      delta: step(project, ++calls, input.prompt), sessionId: "synthetic",
      sessionReused: input.sessionId !== null,
      usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
    }),
  };
  return { project, store, options, kernel: new GoalKernel(store, options), calls: () => calls };
}

test("planning alone does not reset the idle fuse", async t => {
  const h = harness(t, (_, turn) => ({ ...idle, new_todos: [
    { id: `t${turn}`, title: "Plan again", done_when: "later", advances: "a" },
  ] }));
  assert.equal((await h.kernel.runOneTurn()).progress, false);
  assert.equal((await h.kernel.runOneTurn()).stop?.reason, "no_progress");
  await h.kernel.runOneTurn();
  assert.equal(h.calls(), 2);
});

test("repeated claims of a passed check earn no new progress", async t => {
  const h = harness(t, p => {
    writeFileSync(join(p, "a"), "ok");
    return { ...idle, closed: ["a", "a"] };
  });
  assert.deepEqual((await h.kernel.runOneTurn()).verified, ["a"]);
  assert.equal((await h.kernel.runOneTurn()).progress, false);
  assert.equal((await h.kernel.runOneTurn()).stop?.reason, "no_progress");
});

test("a later turn invalidates prior acceptance and reopens its todo", async t => {
  const h = harness(t, (p, turn) => {
    if (turn === 1) {
      writeFileSync(join(p, "a"), "ok");
      return { ...idle, closed: ["a"], new_todos: [
        { id: "ta", title: "Create a", done_when: "a exists", advances: "a" },
      ] };
    }
    unlinkSync(join(p, "a"));
    writeFileSync(join(p, "b"), "ok");
    return { ...idle, closed: ["b"] };
  });
  await h.kernel.runOneTurn();
  const next = await h.kernel.runOneTurn();
  assert.equal(next.stop, null);
  assert.deepEqual(h.store.readState().verified_predicates, ["b"]);
  assert.equal(h.store.readState().todos[0].status, "open");
  assert.match(readFileSync(h.store.viewPath, "utf8"), /\[ \] \*\*a\*\*/);
});

test("external regression is reflected in the next prompt after restart", async t => {
  const h = harness(t, (p, turn, prompt) => {
    if (turn === 2) assert.match(prompt, /- \[ \] a: a exists/);
    writeFileSync(join(p, "a"), "ok");
    return { ...idle, closed: ["a"] };
  });
  await h.kernel.runOneTurn();
  unlinkSync(join(h.project, "a"));
  const restarted = new GoalKernel(h.store, h.options);
  assert.equal((await restarted.runOneTurn()).progress, false, "restoring credited work is not a new checkpoint");
  assert.equal((await restarted.runOneTurn()).stop?.reason, "no_progress");
});

test("completion on the last admitted turn succeeds", async t => {
  const h = harness(t, p => {
    for (const id of ["a", "b"]) writeFileSync(join(p, id), "ok");
    return { ...idle, closed: ["a", "b"] };
  }, { ...spec, policy: { max_turns: 1, max_idle_turns: 1 } });
  assert.equal((await h.kernel.runOneTurn()).stop?.reason, "goal_complete");
  assert.equal(h.store.readState().status, "done");
  await h.kernel.runOneTurn();
  assert.equal(h.calls(), 1);
});

test("an incomplete last turn still exhausts budget", async t => {
  const h = harness(t, () => idle, { ...spec, policy: { max_turns: 1, max_idle_turns: 9 } });
  assert.equal((await h.kernel.runOneTurn()).stop?.reason, "budget_exhausted");
  await h.kernel.runOneTurn();
  assert.equal(h.calls(), 1);
});

test("a changed assumption takes precedence over otherwise complete work", async t => {
  const h = harness(t, p => {
    for (const id of ["a", "b"]) writeFileSync(join(p, id), "ok");
    return { ...idle, closed: ["a", "b"], new_assumptions: [
      { id: "source", statement: "a has fixed contents", source: { kind: "file", path: "a", sha256: "0".repeat(64) } },
    ] };
  }, { ...spec, policy: { max_turns: 1, max_idle_turns: 1 } });
  assert.equal((await h.kernel.runOneTurn()).stop?.reason, "stale_assumption");
});

test("a goal edit during a turn is caught before accepting completion", async t => {
  const h = harness(t, p => {
    for (const id of ["a", "b"]) writeFileSync(join(p, id), "ok");
    const goal = JSON.parse(readFileSync(h.store.goalPath, "utf8"));
    writeFileSync(h.store.goalPath, JSON.stringify({ ...goal, objective: "Different objective" }));
    return { ...idle, closed: ["a", "b"] };
  });
  assert.equal((await h.kernel.runOneTurn()).stop?.reason, "goal_hash_mismatch");
});

test("pending owner decisions prevent any model call", async t => {
  const h = harness(t, () => idle);
  const state = h.store.readState();
  state.pending_decision = {
    turn_id: "earlier", raised_at: "2026-01-01T00:00:00Z", before_hash: state.goal_hash, after_hash: "other",
    proposal: { objective: "change", reason: "requires owner" },
  };
  h.store.writeState(state);
  assert.equal((await h.kernel.runOneTurn()).stop?.reason, "goal_amendment_required");
  assert.equal(h.calls(), 0);
});

test("verified artifacts count even when the model omits a claim", async t => {
  const h = harness(t, p => {
    for (const id of ["a", "b"]) writeFileSync(join(p, id), "ok");
    return idle;
  });
  assert.equal((await h.kernel.runOneTurn()).stop?.reason, "goal_complete");
});

test("legacy state retains earlier progress credit", async t => {
  const h = harness(t, () => ({ ...idle, closed: ["a"] }));
  writeFileSync(join(h.project, "a"), "ok");
  const state = h.store.readState();
  state.verified_predicates = ["a"];
  delete state.credited_predicates;
  h.store.writeState(state);
  assert.equal((await h.kernel.runOneTurn()).progress, false);
});

test("owner-only acceptance is preserved but cannot be claimed by a turn", async t => {
  const g: Goal = { ...spec, predicates: [spec.predicates[0], { id: "owner", statement: "owner accepts", verify: { kind: "owner", note: "review" } }] };
  const h = harness(t, p => { writeFileSync(join(p, "a"), "ok"); return { ...idle, closed: ["a", "owner"] }; }, g);
  assert.equal((await h.kernel.runOneTurn()).stop, null);
  assert.deepEqual(h.store.readState().verified_predicates, ["a"]);
  const state = h.store.readState();
  state.verified_predicates.push("owner");
  h.store.writeState(state);
  assert.equal((await h.kernel.runOneTurn()).stop?.reason, "goal_complete");
  assert.equal(h.calls(), 1);
});
