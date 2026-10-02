import { hashValue, sha256File } from "./hash.ts";
import type {
  Assumption,
  Goal,
  KernelState,
  StopReason,
  Todo,
} from "./types.ts";

/** Mechanical scope references, file revisions and resource limits. */
export interface Violation {
  reason: StopReason;
  detail: string;
}

export interface InvariantReport {
  ok: boolean;
  violations: Violation[];
  /** Assumptions whose declared revision no longer matches the workspace. */
  stale_assumptions: string[];
}

/** 1. Every open todo must name a predicate that exists in the frozen goal. */
export function checkTodoScoping(goal: Goal, todos: Todo[]): Violation[] {
  const known = new Set(goal.predicates.map((p) => p.id));
  const seen = new Set<string>();
  const violations: Violation[] = [];
  for (const todo of todos) {
    const where = `todo ${todo.id}`;
    if (todo.id === "" || seen.has(todo.id)) {
      violations.push({
        reason: "unscoped_todo",
        detail: `${where} is missing an id or duplicated`,
      });
      continue;
    }
    seen.add(todo.id);
    if (todo.status !== "open") continue;
    if (!todo.advances || !known.has(todo.advances)) {
      violations.push({
        reason: "unscoped_todo",
        detail: `${where} (${JSON.stringify(todo.title)}) advances ${
          todo.advances ? `unknown predicate ${todo.advances}` : "no predicate"
        }`,
      });
    }
  }
  return violations;
}

/**
 * 2. Every assumption the loop is relying on must still hold.
 * A file assumption is checked against the recorded content hash, so a
 * revision underneath the loop stops it instead of silently rerouting it.
 */
export function checkAssumptions(
  projectRoot: string,
  assumptions: Assumption[],
): InvariantReport {
  const violations: Violation[] = [];
  const stale: string[] = [];
  const seen = new Set<string>();
  for (const assumption of assumptions) {
    if (seen.has(assumption.id)) {
      violations.push({
        reason: "stale_assumption",
        detail: `assumption ${assumption.id} is declared twice`,
      });
      continue;
    }
    seen.add(assumption.id);
    const path = resolve(projectRoot, assumption.source.path);
    let actual: string;
    try {
      actual = sha256File(path);
    } catch {
      stale.push(assumption.id);
      violations.push({
        reason: "stale_assumption",
        detail: `assumption ${assumption.id} depends on unreadable ${assumption.source.path}`,
      });
      continue;
    }
    if (actual !== assumption.source.sha256) {
      stale.push(assumption.id);
      violations.push({
        reason: "stale_assumption",
        detail: `assumption ${assumption.id} ("${assumption.statement}") recorded ${assumption.source.path} at ${assumption.source.sha256.slice(0, 12)} but it is now ${actual.slice(0, 12)}`,
      });
    }
  }
  return { ok: violations.length === 0, violations, stale_assumptions: stale };
}

/** 3. Budget and owner authority. */
export function checkBudget(goal: Goal, state: KernelState): Violation[] {
  if (state.turn_count >= goal.policy.max_turns) {
    return [
      {
        reason: "budget_exhausted",
        detail: `turn budget ${goal.policy.max_turns} reached`,
      },
    ];
  }
  return [];
}

/** 4. No-progress fuse: N consecutive turns with no verified transition ends the run. */
export function checkProgress(goal: Goal, state: KernelState): Violation[] {
  if (state.no_progress_streak >= goal.policy.max_idle_turns) {
    return [
      {
        reason: "no_progress",
        detail: `${state.no_progress_streak} consecutive turns verified no new checkpoint; the loop is spending without moving`,
      },
    ];
  }
  return [];
}

/**
 * Run all four in a fixed order and return every violation, not just the first,
 * so one stop record explains the whole situation to the owner.
 */
export function checkInvariants(
  goal: Goal,
  state: KernelState,
  projectRoot: string,
): InvariantReport {
  const scoping = checkTodoScoping(goal, state.todos);
  const assumptions = checkAssumptions(projectRoot, state.assumptions);
  const violations = [
    ...scoping,
    ...assumptions.violations,
    ...checkBudget(goal, state),
    ...checkProgress(goal, state),
  ];
  return {
    ok: violations.length === 0,
    violations,
    stale_assumptions: assumptions.stale_assumptions,
  };
}

/**
 * Completion is decided by the kernel's own verified results, never by the
 * turn's claim. `verified_predicates` is refreshed at turn boundaries; passes can be revoked.
 */
export function isGoalComplete(goal: Goal, state: KernelState): boolean {
  if (goal.predicates.length === 0) return false;
  const done = new Set(state.verified_predicates);
  return goal.predicates.every((p) => done.has(p.id));
}

/** Counter helper used by the loop: hash of the parts a turn must not change. */
export function goalFingerprint(goal: Goal): string {
  return hashValue({
    objective: goal.objective,
    predicates: goal.predicates,
    policy: goal.policy,
  });
}

function resolve(root: string, path: string): string {
  if (path.startsWith("/")) return path;
  return `${root.replace(/\/$/, "")}/${path}`;
}
