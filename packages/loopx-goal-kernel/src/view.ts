import type { Goal, KernelState, StopRecord } from "./types.ts";

/** Deterministic projection of (goal, state, journal tail) into the VIEW.md file. */
export function renderView(
  goal: Goal,
  state: KernelState,
  receipts: Array<Record<string, unknown>>,
): string {
  const satisfied = new Set(state.verified_predicates);
  const lines: string[] = [];
  lines.push(`# ${goal.goal_id}`);
  lines.push("");
  lines.push(`- status: **${state.status}**`);
  lines.push(`- goal hash: \`${state.goal_hash}\``);
  lines.push(`- turns spent: ${state.turn_count} / ${goal.policy.max_turns}`);
  lines.push(`- no-progress streak: ${state.no_progress_streak} / ${goal.policy.max_idle_turns}`);
  lines.push(`- codex session: \`${state.session_id ?? "(none yet)"}\``);
  lines.push(
    `- tokens: in ${state.usage_total.input_tokens} (cached ${state.usage_total.cached_input_tokens}), out ${state.usage_total.output_tokens}`,
  );
  lines.push("");
  if (state.stop) lines.push(renderStop(state.stop));
  lines.push(`## Objective`);
  lines.push(state.todos.length === 0 ? "_frozen below_" : "");
  lines.push("```text");
  lines.push(goal.objective);
  lines.push("```");
  lines.push("");
  lines.push("## Acceptance");
  for (const predicate of goal.predicates) {
    lines.push(`- [${satisfied.has(predicate.id) ? "x" : " "}] **${predicate.id}** ${predicate.statement}`);
  }
  lines.push("");
  lines.push("## Todos");
  if (state.todos.length === 0) lines.push("- (none discovered yet)");
  for (const todo of state.todos) {
    lines.push(`- [${todo.status === "done" ? "x" : todo.status === "blocked" ? "!" : " "}] ${todo.id} ${todo.title} → \`${todo.advances}\``);
  }
  lines.push("");
  lines.push("## Assumptions");
  if (state.assumptions.length === 0) lines.push("- (none)");
  for (const assumption of state.assumptions) {
    lines.push(`- ${assumption.id} ${assumption.statement} [${assumption.source.path} @ ${assumption.source.sha256.slice(0, 12)}]`);
  }
  lines.push("");
  lines.push(`## Journal (last ${Math.min(receipts.length, 20)} of ${receipts.length})`);
  lines.push("```text");
  for (const receipt of receipts.slice(-20)) {
    lines.push(formatReceiptLine(receipt));
  }
  lines.push("```");
  lines.push("");
  return lines.filter((line) => line !== "").join("\n").concat("\n");
}

function renderStop(stop: StopRecord): string {
  return [
    `> **STOPPED — ${stop.reason}**`,
    `>`,
    `> ${stop.detail}`,
    `>`,
    `> This run will not spend another turn until the condition is repaired and the goal is resumed.`,
    "",
  ].join("\n");
}

function formatReceiptLine(receipt: Record<string, unknown>): string {
  if (typeof receipt.stop === "object" && receipt.stop !== null) {
    const stop = receipt.stop as StopRecord;
    return `${receipt.at} STOP ${stop.reason}`;
  }
  const closed = Array.isArray(receipt.closed) ? (receipt.closed as string[]) : [];
  const verified = Array.isArray(receipt.verified)
    ? (receipt.verified as Array<{ predicate: string; ok: boolean }>)
    : [];
  const ok = verified.filter((v) => v.ok).map((v) => v.predicate);
  const upgraded = Array.isArray(receipt.admitted_todos) ? (receipt.admitted_todos as string[]) : [];
  const note = typeof receipt.note === "string" && receipt.note ? ` note=${JSON.stringify(receipt.note.slice(0, 120))}` : "";
  return `${receipt.at} turn ${receipt.turn_index} claimed=[${closed.join(",")}] verified=[${ok.join(",")}] new=${upgraded.length} progress=${receipt.progress ? "yes" : "no"}${note}`;
}
