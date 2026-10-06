/** Explore's explicit result attachment. Pure validation/intent; never writes. */
import {createHash} from "node:crypto";
import type {JsonObject} from "../effect_program.ts";
import {EffectRuntimeRequestError} from "../effect_runtime_errors.ts";
import {requireJsonObject, requireStringLiteral} from "../runtime_decode.ts";

export const EXPLORE_RESULT_ATTACHMENT_SCHEMA = "explore_result_attachment_v0";
/** Shared point-of-use guidance; optional metadata never changes settlement. */
export function exploreResultWritebackAffordance(): JsonObject {
  return {
    capability_id: "explore",
    option: "--explore-result-json <result.json>",
    attachment_schema: EXPLORE_RESULT_ATTACHMENT_SCHEMA,
    required: false,
    guidance: "When work yields reusable evidence, attach node_id, question, applicability, input_revision, observation, interpretation, status and evidence_refs to ordinary Todo/Turn refresh-state. This creates the question if absent, preserves existing node state, and links the result to this Todo. Use tentative for inconclusive or prerequisite failures; a score alone does not establish refutation. No attachment is required for routine work without new evidence.",
  };
}

const FIELDS = ["schema_version", "node_id", "question", "applicability", "input_revision",
  "observation", "interpretation", "status", "evidence_refs"];
function text(value: unknown, field: string, limit: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > limit) {
    throw new EffectRuntimeRequestError(`${field} requires nonempty text of at most ${limit} characters`);
  }
  return value.trim();
}
export function normalizeExploreResultAttachment(params: JsonObject): JsonObject {
  const row = requireJsonObject(params.attachment, "Explore result attachment");
  if (Object.keys(row).some(key => !FIELDS.includes(key))) {
    throw new EffectRuntimeRequestError("Explore result attachment contains unknown fields");
  }
  requireStringLiteral(row.schema_version, [EXPLORE_RESULT_ATTACHMENT_SCHEMA], "attachment schema");
  const node = text(row.node_id, "node_id", 96);
  if (!/^[A-Za-z][A-Za-z0-9_.:-]{0,95}$/.test(node)) throw new EffectRuntimeRequestError("invalid Explore node_id");
  if (!Array.isArray(row.evidence_refs) || !row.evidence_refs.length || row.evidence_refs.length > 8) {
    throw new EffectRuntimeRequestError("evidence_refs requires one to eight opaque evidence identifiers");
  }
  const refs = row.evidence_refs.map(value => {
    const ref = text(value, "evidence_ref", 128);
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/.test(ref)) {
      throw new EffectRuntimeRequestError("evidence_ref must be an opaque identifier, not file content");
    }
    return ref;
  });
  // Status reuses the existing finding vocabulary. The caller supplies the
  // interpretation; a failed prerequisite belongs in a tentative observation.
  return {schema_version: EXPLORE_RESULT_ATTACHMENT_SCHEMA, node_id: node,
    question: text(row.question, "question", 180),
    applicability: text(row.applicability, "applicability", 200),
    input_revision: text(row.input_revision, "input_revision", 160),
    observation: text(row.observation, "observation", 300),
    interpretation: text(row.interpretation, "interpretation", 300),
    status: requireStringLiteral(row.status, ["tentative", "confirmed", "refuted"], "finding status"),
    evidence_refs: [...new Set(refs)]};
}
export function produceExploreResultIntent(params: JsonObject): JsonObject {
  const projection = requireJsonObject(params.projection, "writeback projection");
  const attachment = normalizeExploreResultAttachment({attachment: projection.explore_result});
  const receipt = requireJsonObject(params.receipt, "writeback receipt");
  const source = text(receipt.event_id, "source receipt", 200);
  const key = createHash("sha256").update(source).digest("hex");
  return {schema_version: "loopx_post_writeback_capability_hook_result_v0",
    hook_id: "explore.result_writeback", capability_id: "explore", phase: "post_writeback", status: "intent",
    intent: {schema_version: "loopx_capability_intent_v0", intent_kind: "explore.result_ingestion",
      idempotency_key: `explore-result:${key}`, source_receipt_id: source,
      payload: {attachment}, requested_write_scope: []}};
}
