import { join } from "node:path";
import { renderContext } from "./context.ts";
import { runCodexTurn } from "./codex.ts";
import { nowIso } from "./fsutil.ts";
import { hashValue } from "./hash.ts";
import { checkAssumptions, checkBudget, checkProgress, checkTodoScoping, isGoalComplete, goalFingerprint } from "./invariants.ts";
import { GoalStore } from "./store.ts";
import { renderView } from "./view.ts";
import { applyDelta, updateAcceptance } from "./state.ts";
import { verifyAcceptance } from "./verify.ts";
import type {
  Goal,
  KernelState,
  StopReason,
  StopRecord,
  TurnDelta,
  TurnReceipt,
  Usage,
} from "./types.ts";

/** Bounded single-goal loop: check integrity, observe acceptance, act, recheck,
 * settle. External callers own scheduling. This prototype has no concurrency
 * fence or crash-safe transaction spanning journal and state. */
export interface TurnResult {
  turn_id: string;
  turn_index: number;
  verified: string[];
  claimed: string[];
  admitted_todos: string[];
  rejected: Array<{ kind: string; detail: string }>;
  progress: boolean;
  usage: Usage;
  stop: StopRecord | null;
}

export interface KernelOptions {
  projectRoot: string;
  model?: string;
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  /** Injected for tests: replaces the real Codex subprocess. */
  runTurn?: (input: { prompt: string; sessionId: string | null }) => Promise<{
    delta: TurnDelta;
    sessionId: string | null;
    sessionReused: boolean;
    usage: Usage;
  }>;
}

export class GoalKernel {
  readonly store: GoalStore;
  readonly options: KernelOptions;

  constructor(store: GoalStore, options: KernelOptions) {
    this.store = store;
    this.options = options;
  }

  /** Integrity and owner decisions always precede completion or resource limits. */
  private integrity(state: KernelState, goal: Goal): StopRecord | null {
    if (state.goal_hash !== goalFingerprint(goal) ||
        state.goal_hash !== goalFingerprint(this.store.readGoal())) {
      return this.stop("goal_hash_mismatch", "The frozen declaration changed; restore it before continuing.");
    }
    const violations = [
      ...checkTodoScoping(goal, state.todos),
      ...checkAssumptions(this.options.projectRoot, state.assumptions).violations,
    ];
    if (violations.length) return this.stop(violations[0].reason, violations[0].detail);
    if (state.pending_decision) {
      return this.stop("goal_amendment_required",
        "An objective amendment requires the owner: use amend --confirm or amend --reject.",
        state.pending_decision.turn_id);
    }
    return null;
  }

  /** Call only after refreshing acceptance from the workspace. */
  private settlement(state: KernelState, goal: Goal): StopRecord | null {
    if (isGoalComplete(goal, state)) {
      return this.stop("goal_complete", "every acceptance predicate is verified");
    }
    const violations = [...checkBudget(goal, state), ...checkProgress(goal, state)];
    return violations.length ? this.stop(violations[0].reason, violations[0].detail) : null;
  }

  async runOneTurn(): Promise<TurnResult> {
    const goal = this.store.readGoal();
    const state = this.store.readState();
    if (state.status === "stopped") return this.emptyResult(state, state.stop);

    const integrity = this.integrity(state, goal);
    if (integrity) return this.finishStopped(state, integrity);

    // The model must see invalidated work before it chooses its next action.
    const before = verifyAcceptance(this.options.projectRoot, goal, [], state.verified_predicates);
    updateAcceptance(state, before.satisfied);
    if (state.status === "done") {
      if (!isGoalComplete(goal, state)) {
        return this.finishStopped(state, this.stop("acceptance_regressed",
          "Previously completed work no longer passes. Inspect the checks before starting more work."));
      }
      return this.emptyResult(state, state.stop);
    }
    const gate = this.settlement(state, goal);
    if (gate) return this.finishStopped(state, gate);

    const credited = new Set(state.credited_predicates ?? state.verified_predicates);
    const { prompt, ctx_hash } = renderContext(goal, state);
    const turnIndex = state.turn_count + 1;
    const turnId = `turn_${String(turnIndex).padStart(4, "0")}`;
    let result: Awaited<ReturnType<typeof runCodexTurn>>;
    try {
      result = this.options.runTurn
        ? { ...(await this.options.runTurn({ prompt, sessionId: state.session_id })), durationMs: 0 }
        : await runCodexTurn({
            projectRoot: this.options.projectRoot, prompt, sessionId: state.session_id,
            model: this.options.model, sandbox: this.options.sandbox,
          });
    } catch (error) {
      // A failed attempt still consumed a turn. Runtime usage may be unavailable.
      state.turn_count = turnIndex;
      return this.finishStopped(state, this.stop("runtime_error", `${turnId}: ${(error as Error).message}`), turnId);
    }

    state.turn_count = turnIndex;
    state.session_id = result.sessionId ?? state.session_id;
    state.usage_total = addUsage(state.usage_total, result.usage);

    // Re-read the frozen declaration before accepting anything from this turn.
    let stop = this.integrity(state, goal);
    const outcome = stop
      ? { verified: [], rejected: [], satisfied: [] }
      : verifyAcceptance(this.options.projectRoot, goal, result.delta.closed, state.verified_predicates);
    const { admitted, rejected } = stop
      ? { admitted: [], rejected: [] }
      : applyDelta(state, goal, result.delta, outcome.satisfied);
    const newlyVerified = outcome.satisfied.filter(id => !credited.has(id));
    const progress = newlyVerified.length > 0;
    state.credited_predicates = [...new Set([...credited, ...newlyVerified])];
    state.no_progress_streak = progress ? 0 : state.no_progress_streak + 1;

    if (!stop && result.delta.proposed_amendment) {
      state.pending_decision = {
        turn_id: turnId, raised_at: nowIso(), before_hash: state.goal_hash,
        after_hash: goalFingerprint({ ...goal, objective: result.delta.proposed_amendment.objective }),
        proposal: result.delta.proposed_amendment,
      };
    }
    stop ??= this.integrity(state, goal) ?? this.settlement(state, goal);
    if (stop) {
      state.status = stop.reason === "goal_complete" ? "done" : "stopped";
      state.stop = stop;
    }
    const receipt: TurnReceipt = {
      turn_id: turnId, at: nowIso(), turn_index: turnIndex, goal_hash: state.goal_hash,
      ctx_hash, session_id: result.sessionId, session_reused: result.sessionReused,
      usage: result.usage, closed: result.delta.closed, verified: outcome.verified,
      note: result.delta.note, admitted_todos: admitted,
      rejected: [...before.rejected, ...outcome.rejected, ...rejected],
      progress, state_hash_after: hashValue(state),
    };
    this.store.appendReceipt(receipt);
    this.store.writeState(state);
    if (stop) this.store.appendReceipt({ turn_id: turnId, at: nowIso(), stop, state_hash_after: hashValue(state) });
    this.store.writeView(renderView(goal, state, this.store.readJournal() as never));
    return {
      turn_id: turnId, turn_index: turnIndex, verified: newlyVerified,
      claimed: result.delta.closed, admitted_todos: admitted, rejected: receipt.rejected,
      progress, usage: result.usage, stop,
    };
  }

  private finishStopped(
    state: KernelState,
    stop: StopRecord,
    turnId: string | null = null,
    reportedTurnIndex?: number,
  ): TurnResult {
    state.status = stop.reason === "goal_complete" ? "done" : "stopped";
    state.stop = stop;
    this.store.writeState(state);
    const goal = this.store.readGoal();
    this.store.appendReceipt({ turn_id: turnId, at: nowIso(), stop, state_hash_after: hashValue(state) } as never);
    this.store.writeView(renderView(goal, state, this.store.readJournal() as never));
    const result = this.emptyResult(state, stop);
    return reportedTurnIndex === undefined ? result : { ...result, turn_index: reportedTurnIndex };
  }

  private emptyResult(state: KernelState, stop: StopRecord | null): TurnResult {
    return {
      turn_id: state.stop?.turn_id ?? "turn_0000",
      turn_index: state.turn_count,
      verified: [],
      claimed: [],
      admitted_todos: [],
      rejected: [],
      progress: false,
      usage: state.usage_total,
      stop,
    };
  }

  /** Build a stop record without yet persisting it. */
  private stop(reason: StopReason, detail: string, turnId: string | null = null): StopRecord {
    return { reason, detail, at: nowIso(), turn_id: turnId };
  }
}

function addUsage(a: Usage, b: Usage): Usage {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    cached_input_tokens: a.cached_input_tokens + b.cached_input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
  };
}

export function defaultDataRoot(projectRoot: string): string {
  return join(projectRoot, ".loopx", "goal-kernel");
}
