import { EffectRuntimeRequestError } from "../effect_runtime_errors.ts";
import {
  requireBoolean,
  requireJsonObject,
  requireNonEmptyString,
  requireStringArray,
  requireStringLiteral,
  optionalNonEmptyString,
  jsonObject,
} from "../runtime_decode.ts";
import { EffectiveAction } from "../quota/effective_action.generated.ts";

import type { JsonObject } from "../effect_program.ts";

export const INTERACTION_CONTRACT_SCHEMA_VERSION =
  "loopx_interaction_contract_v0";

const USER_CHANNEL_NOTIFICATION_POLICIES = ["NOTIFY", "DONT_NOTIFY"] as const;

export interface UserInteractionChannel extends JsonObject {
  action_required: boolean;
  notify: (typeof USER_CHANNEL_NOTIFICATION_POLICIES)[number];
  non_blocking?: true;
  actions?: string[];
}

export type AgentInteractionChannel =
  | (JsonObject & {
      must_attempt: true;
      delivery_allowed: boolean;
      quiet_noop_allowed: false;
    })
  | (JsonObject & {
      must_attempt: false;
      delivery_allowed: false;
      quiet_noop_allowed: boolean;
    });

export interface InteractionContract extends JsonObject {
  schema_version: typeof INTERACTION_CONTRACT_SCHEMA_VERSION;
  mode: string;
  user_channel: UserInteractionChannel;
  agent_channel: AgentInteractionChannel;
  cli_channel: JsonObject;
}

function decodeUserChannel(value: unknown): UserInteractionChannel {
  const channel = requireJsonObject(value, "interaction_contract.user_channel");
  const actionRequired = requireBoolean(
    channel.action_required,
    "interaction_contract.user_channel.action_required",
  );
  const notify = requireStringLiteral(
    channel.notify,
    USER_CHANNEL_NOTIFICATION_POLICIES,
    "interaction_contract.user_channel.notify",
  );
  const nonBlocking = channel.non_blocking === undefined
    ? undefined
    : requireBoolean(
      channel.non_blocking,
      "interaction_contract.user_channel.non_blocking",
    );
  if (actionRequired && nonBlocking === true) {
    throw new EffectRuntimeRequestError(
      "interaction_contract.user_channel cannot be both required and non-blocking",
    );
  }
  if (nonBlocking === false) {
    throw new EffectRuntimeRequestError(
      "interaction_contract.user_channel.non_blocking must be true when present",
    );
  }
  const decoded: UserInteractionChannel = {
    ...channel,
    action_required: actionRequired,
    notify,
  };
  if (nonBlocking === true) decoded.non_blocking = true;
  if (channel.actions !== undefined) {
    decoded.actions = requireStringArray(
      channel.actions,
      "interaction_contract.user_channel.actions",
    );
  }
  return decoded;
}

function decodeAgentChannel(
  value: unknown,
  { userActionRequired }: { userActionRequired: boolean },
): AgentInteractionChannel {
  const channel = requireJsonObject(value, "interaction_contract.agent_channel");
  const mustAttempt = requireBoolean(
    channel.must_attempt,
    "interaction_contract.agent_channel.must_attempt",
  );
  const deliveryAllowed = requireBoolean(
    channel.delivery_allowed,
    "interaction_contract.agent_channel.delivery_allowed",
  );
  const quietNoopAllowed = requireBoolean(
    channel.quiet_noop_allowed,
    "interaction_contract.agent_channel.quiet_noop_allowed",
  );
  if (deliveryAllowed && !mustAttempt) {
    throw new EffectRuntimeRequestError(
      "interaction_contract.agent_channel cannot allow delivery without an attempt",
    );
  }
  if (quietNoopAllowed && (mustAttempt || deliveryAllowed || userActionRequired)) {
    throw new EffectRuntimeRequestError(
      "interaction_contract quiet no-op conflicts with a required action",
    );
  }
  if (mustAttempt) {
    return {
      ...channel,
      must_attempt: true,
      delivery_allowed: deliveryAllowed,
      quiet_noop_allowed: false,
    };
  }
  return {
    ...channel,
    must_attempt: false,
    delivery_allowed: false,
    quiet_noop_allowed: quietNoopAllowed,
  };
}

/** Decode the final host-facing interaction decision at the existing Effect boundary. */
export function decodeInteractionContract(value: unknown): InteractionContract {
  const contract = requireJsonObject(value, "interaction_contract");
  if (contract.schema_version !== INTERACTION_CONTRACT_SCHEMA_VERSION) {
    throw new EffectRuntimeRequestError(
      `interaction_contract.schema_version must be ${INTERACTION_CONTRACT_SCHEMA_VERSION}`,
    );
  }
  const userChannel = decodeUserChannel(contract.user_channel);
  const agentChannel = decodeAgentChannel(
    contract.agent_channel,
    { userActionRequired: userChannel.action_required },
  );
  return {
    ...contract,
    schema_version: INTERACTION_CONTRACT_SCHEMA_VERSION,
    mode: requireNonEmptyString(contract.mode, "interaction_contract.mode"),
    user_channel: userChannel,
    agent_channel: agentChannel,
    cli_channel: requireJsonObject(
      contract.cli_channel,
      "interaction_contract.cli_channel",
    ),
  };
}

function readArgument(value: unknown, label: string): string | null {
  const text = optionalNonEmptyString(value, label);
  if (text?.includes("\0")) throw new EffectRuntimeRequestError(`${label} contains NUL`);
  return text;
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:-]+$/.test(value) ? value : `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** The adaptive primary is the work identity for both reads and settlement. */
export function selectedWorkTodoId(packet: JsonObject): string | null {
  const orchestration = jsonObject(packet.task_orchestration_contract) ?? {};
  const primaryTodoId = typeof orchestration.primary_todo_id === "string"
    ? orchestration.primary_todo_id.trim() : "";
  if (orchestration.schema_version === "task_orchestration_contract_v2"
      && orchestration.mode === "adaptive" && primaryTodoId) return primaryTodoId;
  const selected = jsonObject(packet.selected_todo) ?? {};
  return typeof selected.todo_id === "string" && selected.todo_id.trim() ? selected.todo_id : null;
}

/** Generate the shared pre-work reads after final admission. Hosts consume this
 * list; transport projections must not independently infer requirements.
 * Python supplies registered source routing, never a second admission rule.
 */
export function projectInteractionRequiredReads(request: JsonObject): JsonObject {
  if (!Array.isArray(request.required_reads)) {
    throw new EffectRuntimeRequestError("required_reads must be an array");
  }
  const reads = request.required_reads.map(value => {
    const read = requireJsonObject(value, "required read");
    readArgument(read.command, "required read command");
    return {...read};
  }).filter(read => read.command);
  const shouldRun = requireBoolean(request.should_run, "should_run");
  const deliveryAllowed = requireBoolean(request.delivery_allowed, "delivery_allowed");
  const selectionRequired = requireBoolean(request.selection_required, "selection_required");
  const hasReplan = requireBoolean(request.has_replan, "has_replan");
  const settlementOnly = requireBoolean(request.settlement_only, "settlement_only");
  const acceptanceEnabled = requireBoolean(request.goal_acceptance_enabled, "goal_acceptance_enabled");
  const goalId = readArgument(request.goal_id, "goal_id");
  if (!shouldRun || !deliveryAllowed || selectionRequired || settlementOnly || !goalId
      || request.effective_action === EffectiveAction.GOVERNED_CAPABILITY_INTENT) {
    return {required_reads: reads};
  }
  const prefix = requireNonEmptyString(request.command_prefix, "command_prefix");
  const goalArg = shellQuote(goalId);
  const add = (command: string, source: string, reason: string) => {
    if (!reads.some(read => read.command === command)) reads.push({command, source, reason});
  };
  const stateFile = readArgument(request.goal_state_file, "goal_state_file");
  if (stateFile) add(`cat -- ${shellQuote(stateFile)}`, "goal_state",
    "Read whole Goal intent, acceptance and stops before work/replan. Use exact Todo reads for task state/claims. Failed reads or changed requirements require a fresh guard; summaries cannot replace this read.");
  if (acceptanceEnabled) add(`${prefix} --format json goal-acceptance inspect --goal-id ${goalArg}`,
    "goal_acceptance", "Read current owner-configured objective, non-goals and all criteria. Honor its scope and revision; this scoped contract does not replace the original Goal or prove completion. If disabled or changed, obtain a fresh guard.");
  const todoId = hasReplan ? null : selectedWorkTodoId(request);
  if (todoId) add(`${prefix} --format json todo list --goal-id ${goalArg} --todo-id ${shellQuote(todoId)}`,
    "selected_todo", "Read full current work requirements. Require one matching active Todo and current status/claim; if missing, ambiguous or changed, obtain a fresh guard before acting. A summary cannot replace this read.");
  return {required_reads: reads};
}
