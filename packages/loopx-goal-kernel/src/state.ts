import type { Goal, KernelState, TurnDelta } from "./types.ts";

/**
 * Apply todo/assumption declarations and the current acceptance snapshot.
 *
 * Admission is strict on purpose: an inadmissible todo or assumption is
 * recorded as rejected rather than repaired into something plausible, because a
 * silent repair is exactly how a scope expansion becomes invisible.
 */
export function applyDelta(
  state: KernelState,
  goal: Goal,
  delta: TurnDelta,
  currentlySatisfied: string[],
): { admitted: string[]; rejected: Array<{ kind: string; detail: string }> } {
  const predicateIds = new Set(goal.predicates.map((p) => p.id));
  const knownTodos = new Set(state.todos.map((t) => t.id));
  const knownAssumptions = new Set(state.assumptions.map((a) => a.id));
  const admitted: string[] = [];
  const rejected: Array<{ kind: string; detail: string }> = [];

  for (const todo of delta.new_todos) {
    if (!todo || typeof todo.id !== "string" || todo.id === "") {
      rejected.push({ kind: "todo_missing_id", detail: JSON.stringify(todo) });
      continue;
    }
    if (knownTodos.has(todo.id)) {
      rejected.push({ kind: "todo_duplicate_id", detail: todo.id });
      continue;
    }
    if (!todo.advances || !predicateIds.has(todo.advances)) {
      rejected.push({
        kind: "todo_unscoped",
        detail: `${todo.id} advances ${todo.advances || "nothing"}; not a declared predicate`,
      });
      continue;
    }
    state.todos.push({
      id: todo.id,
      title: String(todo.title ?? "").slice(0, 500),
      done_when: String(todo.done_when ?? "").slice(0, 500),
      advances: todo.advances,
      status: "open",
    });
    knownTodos.add(todo.id);
    admitted.push(todo.id);
  }

  for (const assumption of delta.new_assumptions) {
    if (!assumption || typeof assumption.id !== "string" || assumption.id === "") {
      rejected.push({ kind: "assumption_missing_id", detail: JSON.stringify(assumption) });
      continue;
    }
    if (knownAssumptions.has(assumption.id)) {
      rejected.push({ kind: "assumption_duplicate_id", detail: assumption.id });
      continue;
    }
    const source = assumption.source;
    if (!source || source.kind !== "file" || typeof source.path !== "string" || !/^[0-9a-f]{64}$/.test(source.sha256 ?? "")) {
      rejected.push({
        kind: "assumption_invalid_source",
        detail: `${assumption.id} must name a file path and its sha256`,
      });
      continue;
    }
    state.assumptions.push({
      id: assumption.id,
      statement: String(assumption.statement ?? "").slice(0, 1000),
      source: { kind: "file", path: source.path, sha256: source.sha256 },
    });
    knownAssumptions.add(assumption.id);
  }

  updateAcceptance(state, currentlySatisfied);
  return { admitted, rejected };
}

/** A completed todo reopens when its acceptance condition no longer holds. */
export function updateAcceptance(state: KernelState, currentlySatisfied: string[]): void {
  const satisfied = new Set(currentlySatisfied);
  state.verified_predicates = [...satisfied];
  for (const todo of state.todos) {
    if (todo.status === "open" && satisfied.has(todo.advances)) todo.status = "done";
    else if (todo.status === "done" && !satisfied.has(todo.advances)) todo.status = "open";
  }
}

