import { hashValue } from "./hash.ts";
import type { Goal, KernelState, Todo } from "./types.ts";

/** Render the explicit goal prompt deterministically. Codex session history and
 * workspace inputs are separate; this hash alone cannot replay a past turn. */
export interface RenderedContext {
  prompt: string;
  ctx_hash: string;
}

export function renderContext(goal: Goal, state: KernelState): RenderedContext {
  const open = state.todos.filter((t) => t.status === "open");
  const blocked = state.todos.filter((t) => t.status === "blocked");
  const satisfied = new Set(state.verified_predicates);

  const lines: string[] = [];
  lines.push("You are continuing one long-running goal. Work exactly one bounded step, then report.");
  lines.push("");
  lines.push(`## Objective (frozen, hash ${state.goal_hash.slice(0, 12)})`);
  lines.push(goal.objective);
  lines.push("");
  lines.push("## Acceptance predicates — verified independently by the harness, not by you");
  for (const predicate of goal.predicates) {
    const mark = satisfied.has(predicate.id) ? "x" : " ";
    lines.push(`- [${mark}] ${predicate.id}: ${predicate.statement}  (checked by: ${describeVerify(predicate.verify)})`);
  }
  lines.push("");
  lines.push("## Open work");
  if (open.length === 0) {
    lines.push("- (none)");
  } else {
    for (const todo of open) lines.push(renderTodo(todo));
  }
  lines.push("");
  lines.push("## Blocked work");
  if (blocked.length === 0) {
    lines.push("- (none)");
  } else {
    for (const todo of blocked) lines.push(renderTodo(todo));
  }
  lines.push("");
  lines.push("## Assumptions this run depends on (a change to any of these stops the run)");
  if (state.assumptions.length === 0) {
    lines.push("- (none)");
  } else {
    for (const assumption of state.assumptions) {
      lines.push(`- ${assumption.id}: ${assumption.statement}  [${assumption.source.path} @ ${assumption.source.sha256.slice(0, 12)}]`);
    }
  }
  lines.push("");
  lines.push(`## Budget remaining: ${Math.max(0, goal.policy.max_turns - state.turn_count)} of ${goal.policy.max_turns} turns`);
  if (state.no_progress_streak > 0) {
    lines.push(`## Warning: ${state.no_progress_streak} consecutive turn(s) verified no new checkpoint. The run stops after ${goal.policy.max_idle_turns}.`);
  }
  lines.push("");
  lines.push(INSTRUCTIONS);

  const prompt = lines.join("\n");
  return { prompt, ctx_hash: hashValue(prompt) };
}

function renderTodo(todo: Todo): string {
  return `- ${todo.id}: ${todo.title}\n    done when: ${todo.done_when}\n    advances predicate: ${todo.advances}`;
}

function describeVerify(spec: Goal["predicates"][number]["verify"]): string {
  switch (spec.kind) {
    case "command":
      return `harness runs \`${spec.run}\``;
    case "file_exists":
      return `harness checks ${spec.path} exists`;
    case "file_sha256":
      return `harness checks ${spec.path} matches a recorded digest`;
    case "owner":
      return `the owner decides; never the agent`;
  }
}

const INSTRUCTIONS = `## What to return

Perform the workspace changes first, then return one JSON object as your final response:

{
  "closed": ["<predicate ids you believe now hold>"],
  "new_todos": [{"id":"t3","title":"...","done_when":"...","advances":"<predicate id>"}],
  "new_assumptions": [{"id":"a1","statement":"...","source":{"kind":"file","path":"...","sha256":"<sha256 of that file now>"}}],
  "proposed_amendment": {"objective":"...","reason":"..."} | null,
  "note": "one short sentence"
}

Reporting and verification rules:
- Only claim a predicate in "closed" if the workspace now actually satisfies it; the harness re-runs all checks, revokes stale passes, and ignores unverified claims.
- New todos and repeated passes do not count as progress. A checkpoint earns progress only the first time it passes. Repair regressed work and continue toward the remaining checkpoints.
- Every todo you add must set "advances" to a predicate id declared above. A todo that names no declared predicate is rejected. You must also keep the actual work within the objective; the id check does not establish semantic relevance.
- "proposed_amendment" is for changing the objective. It does not take effect: the run stops and asks the owner. Do not use it to restate work as done.
- Report only what this turn actually changed on disk or in reality.`;
