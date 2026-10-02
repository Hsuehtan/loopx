#!/usr/bin/env -S node --no-warnings --experimental-strip-types
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { GoalKernel, defaultDataRoot } from "./kernel.ts";
import { GoalStore } from "./store.ts";
import { sha256File } from "./hash.ts";
import { nowIso } from "./fsutil.ts";
import { renderView } from "./view.ts";
import { goalFingerprint } from "./invariants.ts";
import type { Goal, KernelState } from "./types.ts";

/**
 * The prototype's operator surface.
 *
 * `loopx-goal <verb> --project <dir> --id <goal id>`
 *
 * There is no daemon, no dashboard, no configuration file and no scheduler.
 * Each invocation reads two small files, does one bounded thing, and writes them
 * back. `run --turns N` is what a host clock would call; the kernel never
 * decides for itself that it is time to run again.
 */
const USAGE = `loopx-goal — minimal deterministic long-horizon goal kernel

  init    --project DIR --id ID --spec FILE        freeze the goal declaration
  run     --project DIR --id ID [--turns N]        run bounded turns (default 1)
  status  --project DIR --id ID                    print the current state
  view    --project DIR --id ID                    print/viewer the VIEW.md projection
  amend   --project DIR --id ID --confirm|--reject resolve a pending amendment
  accept  --project DIR --id ID --predicate P      record an owner decision
  hash    --project DIR --file PATH                sha256 for an assumption source

The spec file is JSON:
  { "goal_id": "g", "objective": "...", "predicates": [...], "policy": {...} }
`;

interface Options {
  verb: string;
  project: string;
  id: string | null;
  spec: string | null;
  file: string | null;
  predicate: string | null;
  note: string;
  turns: number;
  model: string | null;
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
  confirm: boolean;
  reject: boolean;
}

function parseArgs(argv: string[]): Options {
  const verb = argv[0] ?? "help";
  const options: Options = {
    verb,
    project: process.cwd(),
    id: null,
    spec: null,
    file: null,
    predicate: null,
    note: "",
    turns: 1,
    model: null,
    sandbox: "workspace-write",
    confirm: false,
    reject: false,
  };
  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1];
    switch (token) {
      case "--project":
        options.project = resolve(next);
        index += 1;
        break;
      case "--id":
        options.id = next;
        index += 1;
        break;
      case "--spec":
        options.spec = resolve(next);
        index += 1;
        break;
      case "--file":
        options.file = resolve(next);
        index += 1;
        break;
      case "--predicate":
        options.predicate = next;
        index += 1;
        break;
      case "--note":
        options.note = next;
        index += 1;
        break;
      case "--turns":
        options.turns = Number(next);
        if (!Number.isSafeInteger(options.turns) || options.turns < 1) throw new Error("--turns must be a positive integer");
        index += 1;
        break;
      case "--model":
        options.model = next;
        index += 1;
        break;
      case "--sandbox": {
        if (next !== "read-only" && next !== "workspace-write" && next !== "danger-full-access") {
          throw new Error(`--sandbox must be read-only, workspace-write or danger-full-access`);
        }
        options.sandbox = next;
        index += 1;
        break;
      }
      case "--confirm":
        options.confirm = true;
        break;
      case "--reject":
        options.reject = true;
        break;
      default:
        throw new Error(`unknown argument: ${token}`);
    }
  }
  return options;
}

function requireId(options: Options): string {
  if (!options.id) throw new Error("--id is required");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(options.id)) throw new Error("--id must be a simple alphanumeric name (hyphens and underscores allowed)");
  return options.id;
}

function store(options: Options): GoalStore {
  return new GoalStore(options.project, defaultDataRoot(options.project), requireId(options));
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  if (options.verb === "help" || options.verb === "--help" || options.verb === "-h") {
    process.stdout.write(USAGE);
    return 0;
  }

  switch (options.verb) {
    case "hash": {
      if (!options.file) throw new Error("--file is required");
      process.stdout.write(`${sha256File(options.file)}\n`);
      return 0;
    }
    case "init":
      return init(options);
    case "run":
      return run(options);
    case "status":
      return status(options);
    case "view": {
      const goalStore = store(options);
      const goal = goalStore.readGoal();
      const state = goalStore.readState();
      process.stdout.write(renderView(goal, state, goalStore.readJournal() as never));
      return state.status === "stopped" ? 3 : 0;
    }
    case "amend":
      return amend(options);
    case "accept":
      return accept(options);
    default:
      process.stderr.write(`unknown verb: ${options.verb}\n\n${USAGE}`);
      return 2;
  }
}

function init(options: Options): number {
  if (!options.spec) throw new Error("--spec is required");
  const spec = JSON.parse(readFileSync(options.spec, "utf8")) as Goal;
  const goalStore = store(options);
  if (existsSync(goalStore.goalPath) || existsSync(goalStore.statePath)) {
    throw new Error("goal already exists; init cannot overwrite its declaration or reset its budget");
  }
  if (spec.goal_id !== options.id || typeof spec.objective !== "string" || !spec.objective.trim()) {
    throw new Error("spec requires the matching goal_id and a nonempty objective");
  }
  for (const value of [spec.policy?.max_turns, spec.policy?.max_idle_turns]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error("policy limits must be positive integers");
  }
  if (!Array.isArray(spec.predicates) || !spec.predicates.length) throw new Error("spec requires acceptance predicates");
  const ids = new Set<string>();
  for (const predicate of spec.predicates) {
    if (!predicate || typeof predicate.id !== "string" || !predicate.id || ids.has(predicate.id)) {
      throw new Error("predicate ids must be nonempty and unique");
    }
    ids.add(predicate.id);
    const v = predicate.verify;
    if (!v || !["command", "file_exists", "file_sha256", "owner"].includes(v.kind)) throw new Error(`invalid verifier for ${predicate.id}`);
    if (v.kind === "command" && (typeof v.run !== "string" || !v.run.trim() ||
        (v.timeout_ms !== undefined && (!Number.isSafeInteger(v.timeout_ms) || v.timeout_ms < 1)))) throw new Error(`invalid command check for ${predicate.id}`);
    if ((v.kind === "file_exists" || v.kind === "file_sha256") && (typeof v.path !== "string" || !v.path)) throw new Error(`invalid file check for ${predicate.id}`);
    if (v.kind === "file_sha256" && !/^[0-9a-f]{64}$/.test(v.sha256)) throw new Error(`invalid digest for ${predicate.id}`);
  }
  const { goal_hash } = goalStore.initGoal(spec);
  process.stdout.write(`initialized ${spec.goal_id}\n  goal hash: ${goal_hash}\n  data: ${goalStore.goalDir}\n`);
  return 0;
}

async function run(options: Options): Promise<number> {
  const goalStore = store(options);
  const kernel = new GoalKernel(goalStore, {
    projectRoot: options.project,
    model: options.model ?? undefined,
    sandbox: options.sandbox,
  });
  let exit = 0;
  for (let turn = 0; turn < Math.max(1, options.turns); turn += 1) {
    const result = await kernel.runOneTurn();
    process.stdout.write(
      `turn ${result.turn_index}: verified=[${result.verified.join(",")}] claimed=[${result.claimed.join(",")}] new=[${result.admitted_todos.join(",")}] progress=${result.progress ? "yes" : "no"}\n`,
    );
    for (const rejection of result.rejected) {
      process.stdout.write(`  rejected ${rejection.kind}: ${rejection.detail}\n`);
    }
    if (result.stop) {
      process.stdout.write(`\nSTOPPED: ${result.stop.reason}\n  ${result.stop.detail}\n`);
      // A finished goal is success; any other stop is a condition the owner must repair.
      exit = result.stop.reason === "goal_complete" ? 0 : 3;
      break;
    }
    const state = goalStore.readState();
    if (state.status !== "running") {
      exit = state.status === "done" ? 0 : 3;
      break;
    }
  }
  return exit;
}

function status(options: Options): number {
  const goalStore = store(options);
  const goal = goalStore.readGoal();
  const state = goalStore.readState();
  const satisfied = new Set(state.verified_predicates);
  process.stdout.write(`${goal.goal_id}  status=${state.status}  turns=${state.turn_count}/${goal.policy.max_turns}  idle=${state.no_progress_streak}/${goal.policy.max_idle_turns}\n`);
  process.stdout.write(`tokens in=${state.usage_total.input_tokens} cached=${state.usage_total.cached_input_tokens} out=${state.usage_total.output_tokens}\n`);
  for (const predicate of goal.predicates) {
    process.stdout.write(`  [${satisfied.has(predicate.id) ? "x" : " "}] ${predicate.id} ${predicate.statement}\n`);
  }
  for (const todo of state.todos) {
    process.stdout.write(`  todo ${todo.id} (${todo.status}) → ${todo.advances}: ${todo.title}\n`);
  }
  if (state.stop) {
    process.stdout.write(`\nstopped: ${state.stop.reason}\n  ${state.stop.detail}\n`);
    return state.stop.reason === "goal_complete" ? 0 : 3;
  }
  return 0;
}

function amend(options: Options): number {
  const goalStore = store(options);
  const goal = goalStore.readGoal();
  const state = goalStore.readState();
  if (!state.pending_decision) {
    process.stderr.write("no pending amendment\n");
    return 4;
  }
  const decision = state.pending_decision;
  if (options.reject) {
    state.pending_decision = null;
    state.stop = null;
    state.status = "running";
    goalStore.writeState(state);
    process.stdout.write(`rejected amendment from ${decision.turn_id}; objective unchanged\n`);
    return 0;
  }
  if (options.confirm) {
    if (state.goal_hash !== goalFingerprint(goal)) throw new Error("goal hash mismatch; restore the declaration first");
    const updated: Goal = { ...goal, objective: decision.proposal.objective };
    goalStore.initGoal(updated);
    state.goal_hash = goalFingerprint(updated);
    state.pending_decision = null;
    state.stop = null;
    state.status = "running";
    goalStore.writeState(state);
    goalStore.writeView(renderView(updated, state, goalStore.readJournal() as never));
    process.stdout.write(`adopted amendment from ${decision.turn_id}; new goal hash ${state.goal_hash}\n`);
    return 0;
  }
  process.stderr.write(`pending amendment from ${decision.turn_id}:\n  reason: ${decision.proposal.reason}\n  objective: ${decision.proposal.objective}\n\nRe-run with --confirm or --reject.\n`);
  return 4;
}

function accept(options: Options): number {
  const goalStore = store(options);
  const goal = goalStore.readGoal();
  const state = goalStore.readState();
  if (!options.predicate) throw new Error("--predicate is required");
  const predicate = goal.predicates.find((p) => p.id === options.predicate);
  if (!predicate) throw new Error(`unknown predicate ${options.predicate}`);
  if (predicate.verify.kind !== "owner") throw new Error("accept is reserved for owner predicates; automatic checks must pass verification");
  if (state.goal_hash !== goalFingerprint(goal)) throw new Error("goal hash mismatch; restore the declaration first");
  if (!state.verified_predicates.includes(predicate.id)) {
    state.verified_predicates.push(predicate.id);
  }
  const note = options.note || `owner accepted at ${nowIso()}`;
  goalStore.appendReceipt({
    turn_id: null,
    at: nowIso(),
    owner_decision: { predicate: predicate.id, kind: "accept", note },
    state_hash_after: "",
  } as never);
  for (const todo of state.todos) {
    if (todo.advances === predicate.id && todo.status === "open") todo.status = "done";
  }
  state.stop = null;
  if (state.status === "stopped") state.status = "running";
  goalStore.writeState(state);
  goalStore.writeView(renderView(goal, state, goalStore.readJournal() as never));
  process.stdout.write(`recorded owner acceptance of ${predicate.id}: ${note}\n`);
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`error: ${(error as Error).message}\n`);
    process.exitCode = 1;
  });

export type { KernelState };
