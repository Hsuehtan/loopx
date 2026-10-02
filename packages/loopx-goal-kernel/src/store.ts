import { join } from "node:path";
import { atomicWriteJson, atomicWriteText, appendJsonl, readJson, readJsonl } from "./fsutil.ts";
import { hashValue } from "./hash.ts";
import { goalFingerprint } from "./invariants.ts";
import type {
  Goal,
  KernelState,
  StopReceipt,
  TurnReceipt,
} from "./types.ts";

/**
 * One directory per goal, four files, no database:
 *
 *   goal/1.0.0.json          current declaration (changed only by explicit amendment)
 *   state.json               the whole mutable state, a few KB
 *   journal.jsonl            append-only receipts, one line per turn
 *   VIEW.md                  deterministic human/agent-readable projection
 *
 * There is deliberately no index, cache, lease, lock file or second store.
 * Everything the loop needs between turns fits in `state.json`, so a fresh
 * process (or a fresh session days later) reconstructs the loop by reading two
 * files instead of trusting prose from a previous run.
 */
export class GoalStore {
  readonly projectRoot: string;
  readonly dataRoot: string;
  readonly goalId: string;
  readonly goalDir: string;
  readonly goalPath: string;
  readonly statePath: string;
  readonly journalPath: string;
  readonly viewPath: string;

  constructor(projectRoot: string, dataRoot: string, goalId: string) {
    this.projectRoot = projectRoot;
    this.dataRoot = dataRoot;
    this.goalId = goalId;
    this.goalDir = join(dataRoot, "goals", goalId);
    this.goalPath = join(this.goalDir, "goal", "1.0.0.json");
    this.statePath = join(this.goalDir, "state.json");
    this.journalPath = join(this.goalDir, "journal.jsonl");
    this.viewPath = join(this.goalDir, "VIEW.md");
  }

  initGoal(goal: Goal): { created: boolean; goal_hash: string } {
    const goal_hash = goalFingerprint(goal);
    atomicWriteJson(this.goalPath, { ...goal, goal_hash });
    const state: KernelState = {
      version: 1,
      goal_id: goal.goal_id,
      goal_hash,
      session_id: null,
      turn_count: 0,
      usage_total: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 },
      todos: [],
      assumptions: [],
      verified_predicates: [],
      credited_predicates: [],
      pending_decision: null,
      no_progress_streak: 0,
      status: "running",
      stop: null,
    };
    atomicWriteJson(this.statePath, state);
    return { created: true, goal_hash };
  }

  readGoal(): Goal {
    const raw = readJson<Goal & { goal_hash?: string }>(this.goalPath);
    return {
      goal_id: raw.goal_id,
      objective: raw.objective,
      predicates: raw.predicates,
      policy: raw.policy,
    };
  }

  readState(): KernelState {
    const state = readJson<KernelState>(this.statePath);
    state.credited_predicates ??= [...state.verified_predicates];
    return state;
  }

  writeState(state: KernelState): void {
    atomicWriteJson(this.statePath, state);
  }

  appendReceipt(receipt: TurnReceipt | StopReceipt): void {
    appendJsonl(this.journalPath, receipt);
  }

  readJournal(): Array<TurnReceipt | StopReceipt> {
    return readJsonl<TurnReceipt | StopReceipt>(this.journalPath);
  }

  writeView(view: string): void {
    atomicWriteText(this.viewPath, view);
  }

  /** Hash of the mutable state as persisted. Used to prove a turn changed something. */
  stateHash(state: KernelState): string {
    return hashValue(state);
  }
}
