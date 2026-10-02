import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { sha256File } from "./hash.ts";
import type { Goal, Predicate, VerifiedPredicate } from "./types.ts";

/**
 * Re-run the declared checks independently of model claims. Commands must be
 * trusted, repeatable checks: this is not an isolated verifier security boundary.
 */
export interface VerifyOutcome {
  verified: VerifiedPredicate[];
  /** Predicates the turn claimed but the kernel could not confirm. */
  rejected: Array<{ kind: string; detail: string }>;
  /** Predicate ids now decided true. */
  satisfied: string[];
}

export function verifyAcceptance(
  projectRoot: string,
  goal: Goal,
  claimed: string[] = [],
  previouslyVerified: string[] = [],
): VerifyOutcome {
  const byId = new Map(goal.predicates.map((p) => [p.id, p]));
  const verified: VerifiedPredicate[] = [];
  const rejected: Array<{ kind: string; detail: string }> = [];
  const satisfied: string[] = [];
  const claims = new Set(claimed);
  const previous = new Set(previouslyVerified);
  for (const id of claims) {
    if (!byId.has(id)) {
      rejected.push({
        kind: "unknown_predicate",
        detail: `turn claimed ${id}, which is not declared in the frozen goal`,
      });
    }
  }
  for (const predicate of goal.predicates) {
    const id = predicate.id;
    const outcome = predicate.verify.kind === "owner" && previous.has(id)
      ? { ok: true, evidence: "retained explicit owner acceptance" }
      : verifyPredicate(projectRoot, predicate);
    verified.push({ predicate: id, ...outcome });
    if (outcome.ok) {
      satisfied.push(id);
    } else if (claims.has(id)) {
      rejected.push({ kind: "unverified_claim", detail: `${id}: ${outcome.evidence}` });
    }
    if (!outcome.ok && previous.has(id)) {
      rejected.push({ kind: "acceptance_regressed", detail: `${id}: ${outcome.evidence}` });
    }
  }
  return { verified, rejected, satisfied };
}

export function verifyPredicate(
  projectRoot: string,
  predicate: Predicate,
): { ok: boolean; evidence: string } {
  const spec = predicate.verify;
  switch (spec.kind) {
    case "file_exists": {
      const path = resolve(projectRoot, spec.path);
      const ok = existsSync(path);
      return { ok, evidence: `file_exists ${spec.path}: ${ok ? "present" : "missing"}` };
    }
    case "file_sha256": {
      const path = resolve(projectRoot, spec.path);
      try {
        const actual = sha256File(path);
        const ok = actual === spec.sha256;
        return {
          ok,
          evidence: `file_sha256 ${spec.path}: ${actual.slice(0, 12)} expected ${spec.sha256.slice(0, 12)}`,
        };
      } catch {
        return { ok: false, evidence: `file_sha256 ${spec.path}: unreadable` };
      }
    }
    case "command": {
      const result = spawnSync("bash", ["-lc", spec.run], {
        cwd: spec.cwd ? resolve(projectRoot, spec.cwd) : projectRoot,
        timeout: spec.timeout_ms ?? 120_000,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      });
      const code = result.status ?? -1;
      const stdout = result.stdout ?? "";
      const expectExit = spec.expect_exit ?? 0;
      let ok = code === expectExit;
      if (ok && spec.expect_stdout !== undefined) ok = stdout.includes(spec.expect_stdout);
      const detail = `command exit ${code} (expected ${expectExit})${spec.expect_stdout !== undefined ? `, stdout ${stdout.includes(spec.expect_stdout) ? "matched" : "did not match"}` : ""}`;
      return { ok, evidence: detail };
    }
    case "owner":
      return {
        ok: false,
        evidence: `owner-only predicate; the kernel never self-certifies it (${spec.note})`,
      };
  }
}

function resolve(root: string, path: string): string {
  if (path.startsWith("/")) return path;
  return `${root.replace(/\/$/, "")}/${path}`;
}
