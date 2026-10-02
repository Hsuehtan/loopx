/** Local prototype state vocabulary; not a shared LoopX authority contract. */

export type GoalId = string;
export type TodoId = string;
export type PredicateId = string;
export type AssumptionId = string;
export type TurnId = string;

/**
 * How one acceptance predicate is decided.
 *
 * A `command` or file check is executed by the kernel itself, never by the
 * model. `owner` exists so a human-only predicate can be declared honestly
 * instead of being silently approximated by prose.
 */
export type VerifySpec =
  | {
      kind: "command";
      run: string;
      cwd?: string;
      timeout_ms?: number;
      expect_exit?: number;
      expect_stdout?: string;
    }
  | { kind: "file_exists"; path: string }
  | { kind: "file_sha256"; path: string; sha256: string }
  | { kind: "owner"; note: string };

export interface Predicate {
  id: PredicateId;
  statement: string;
  verify: VerifySpec;
}

export const TODO_STATUSES = ["open", "done", "blocked"] as const;
export type TodoStatus = (typeof TODO_STATUSES)[number];

export interface Todo {
  id: TodoId;
  title: string;
  done_when: string;
  /** The acceptance predicate this todo advances. A todo that cannot name one is not admissible. */
  advances: PredicateId;
  status: TodoStatus;
}

export interface AssumptionSource {
  kind: "file";
  path: string;
  sha256: string;
}

export interface Assumption {
  id: AssumptionId;
  statement: string;
  source: AssumptionSource;
}

export interface GoalPolicy {
  /** Hard ceiling on Codex turns for this goal. */
  max_turns: number;
  /** Consecutive turns with no verified progress before the loop stops and asks. */
  max_idle_turns: number;
}

/** The frozen declaration. `goal_hash` covers the canonical form of exactly this object. */
export interface Goal {
  goal_id: GoalId;
  objective: string;
  predicates: Predicate[];
  policy: GoalPolicy;
}

/**
 * What one Codex turn must return.
 * The adapter's deltaJsonSchema supplies the structured output schema.
 */
export interface TurnDelta {
  /** Predicate ids the turn believes it satisfied. The kernel verifies each one itself. */
  closed: PredicateId[];
  new_todos: Array<{
    id: TodoId;
    title: string;
    done_when: string;
    advances: PredicateId;
  }>;
  new_assumptions: Array<{
    id: AssumptionId;
    statement: string;
    source: AssumptionSource;
  }>;
  /** Set only when the objective itself must change. The loop stops and asks the owner. */
  proposed_amendment: { objective: string; reason: string } | null;
  note: string;
}

export const STOP_REASONS = [
  "goal_complete",
  "goal_amendment_required",
  "owner_decision_pending",
  "unscoped_todo",
  "stale_assumption",
  "budget_exhausted",
  "no_progress",
  "runtime_error",
  "goal_hash_mismatch",
  "acceptance_regressed",
] as const;
export type StopReason = (typeof STOP_REASONS)[number];

export interface StopRecord {
  reason: StopReason;
  detail: string;
  at: string;
  turn_id: TurnId | null;
}

export interface Usage {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
}

export const EMPTY_USAGE: Usage = {
  input_tokens: 0,
  cached_input_tokens: 0,
  output_tokens: 0,
};

export interface PendingDecision {
  turn_id: TurnId;
  raised_at: string;
  /** Goal hash before the proposal. The proposal can only ever move this to `after_hash`. */
  before_hash: string;
  after_hash: string;
  proposal: { objective: string; reason: string };
}

export const KERNEL_STATUSES = ["running", "done", "stopped"] as const;
export type KernelStatus = (typeof KERNEL_STATUSES)[number];

export interface KernelState {
  version: 1;
  goal_id: GoalId;
  /** Frozen at init. Any later mismatch is a hard stop, not a re-read. */
  goal_hash: string;
  /** Codex thread to resume; null before the first turn. */
  session_id: string | null;
  turn_count: number;
  usage_total: Usage;
  todos: Todo[];
  assumptions: Assumption[];
  /** Current acceptance snapshot; automatic checks are re-run at turn boundaries. */
  verified_predicates: PredicateId[];
  /** Checkpoints already credited. Optional for reading the original v1 prototype. */
  credited_predicates?: PredicateId[];
  pending_decision: PendingDecision | null;
  no_progress_streak: number;
  status: KernelStatus;
  stop: StopRecord | null;
}

export interface VerifiedPredicate {
  predicate: PredicateId;
  ok: boolean;
  evidence: string;
}

/** One appended line of `journal.jsonl`. */
export interface TurnReceipt {
  turn_id: TurnId;
  at: string;
  turn_index: number;
  goal_hash: string;
  ctx_hash: string;
  session_id: string | null;
  session_reused: boolean;
  usage: Usage;
  closed: PredicateId[];
  verified: VerifiedPredicate[];
  /** The turn's own one-line summary. Recorded so a human can see why a turn did nothing. */
  note: string;
  admitted_todos: TodoId[];
  rejected: Array<{ kind: string; detail: string }>;
  progress: boolean;
  state_hash_after: string;
}

/** Terminal journal records share the file with receipts so one tail shows the whole story. */
export interface StopReceipt {
  turn_id: TurnId | null;
  at: string;
  stop: StopRecord;
  state_hash_after: string;
}
