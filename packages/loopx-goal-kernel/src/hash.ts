import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * Stable serialisation: object keys sorted at every depth, so two structurally
 * equal values always produce the same bytes. Hashing depends on this.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) out[key] = sortValue(source[key]);
    return out;
  }
  return value;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function hashValue(value: unknown): string {
  return sha256(canonicalJson(value));
}

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Short form used in human-facing views. Never used for comparison. */
export function short(hash: string): string {
  return hash.slice(0, 12);
}
