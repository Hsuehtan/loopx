#!/usr/bin/env -S node --no-warnings --experimental-strip-types
/** Real CLI continuation and regression-recovery smoke. Spends model tokens.
 * Synthetic work is deliberately split across turns to exercise the protocol;
 * passing this check is not long-horizon performance evidence. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sandboxIndex = process.argv.indexOf("--sandbox");
const sandbox = sandboxIndex < 0 ? "workspace-write" : process.argv[sandboxIndex + 1];
const cli = new URL("../src/cli.ts", import.meta.url).pathname;
const project = mkdtempSync(join(tmpdir(), "gk-live-"));
const data = join(project, ".loopx", "goal-kernel", "goals", "live");
const readState = () => JSON.parse(readFileSync(join(data, "state.json"), "utf8"));
const contents = [1, 2, 3, 4].map(n => `checkpoint ${n}\n`);

function run(verb: string, extra: string[] = []) {
  const result = spawnSync(process.execPath, ["--no-warnings", "--experimental-strip-types", cli,
    verb, "--project", project, "--id", "live", ...extra], {
    encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 10 * 60_000,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  assert.equal(result.error, undefined, result.error?.message);
  return { code: result.status, output };
}

try {
  const spec = join(project, "spec.json");
  writeFileSync(spec, JSON.stringify({
    goal_id: "live",
    objective: "Create part-1.txt through part-4.txt. File N must contain exactly checkpoint N followed by one newline. " +
      "Each turn, fix exactly ONE file: the lowest-numbered file whose contents are missing or wrong. " +
      "Read the current files each turn; earlier files may be changed externally. Preserve all correct files. " +
      "Do not alter the spec or harness state. Finish after all four files are correct.",
    predicates: contents.map((content, index) => ({
      id: `p${index + 1}`, statement: `part-${index + 1}.txt contains exactly ${JSON.stringify(content)}`,
      verify: { kind: "file_sha256", path: `part-${index + 1}.txt`, sha256: createHash("sha256").update(content).digest("hex") },
    })),
    policy: { max_turns: 5, max_idle_turns: 2 },
  }));
  const init = run("init", ["--spec", spec]);
  assert.equal(init.code, 0, init.output);
  let session: string | null = null;
  for (let turn = 1; turn <= 5; turn++) {
    // Each invocation is a new kernel process resuming the persisted Codex session.
    const result = run("run", ["--turns", "1", "--sandbox", sandbox]);
    assert.equal(result.code, 0, result.output);
    const state = readState();
    assert.equal(state.turn_count, turn);
    assert.ok(state.session_id);
    session ??= state.session_id;
    assert.equal(state.session_id, session);
    if (turn === 1) {
      assert.deepEqual(state.verified_predicates, ["p1"]);
      writeFileSync(join(project, "part-1.txt"), "external regression\n");
    }
    if (turn === 2) {
      assert.equal(state.no_progress_streak, 1, "restored checkpoint cannot earn progress twice");
      assert.equal(readFileSync(join(project, "part-1.txt"), "utf8"), contents[0]);
    }
    console.log(`turn ${turn}: accepted=${state.verified_predicates.length}/4 idle=${state.no_progress_streak} status=${state.status}`);
  }
  const state = readState();
  assert.equal(state.status, "done");
  assert.equal(state.stop.reason, "goal_complete", "completion must beat budget exhaustion on turn five");
  contents.forEach((expected, index) => assert.equal(readFileSync(join(project, `part-${index + 1}.txt`), "utf8"), expected));
  const journal = readFileSync(join(data, "journal.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  const turns = journal.filter(row => "ctx_hash" in row);
  assert.equal(turns.length, 5);
  assert.ok(turns.slice(1).every(row => row.session_reused));
  assert.equal(turns[1].progress, false);
  assert.ok(turns[1].rejected.some((r: { kind: string }) => r.kind === "acceptance_regressed"));
  assert.equal(run("status").code, 0);
  assert.match(run("view").output, /\[x\] \*\*p4\*\*/);

  // A completed run must not return stale success or spend another model turn.
  writeFileSync(join(project, "part-1.txt"), "changed after completion\n");
  const recheck = run("run", ["--turns", "1", "--sandbox", sandbox]);
  assert.equal(recheck.code, 3, recheck.output);
  assert.equal(readState().turn_count, 5);
  assert.equal(readState().stop.reason, "acceptance_regressed");
  assert.equal(run("status").code, 3);
  assert.match(run("view").output, /\[ \] \*\*p1\*\*/);
  console.log("live smoke passed: five turns, process restarts, regression repair, budget-edge completion, stale-success rejection");
} finally {
  rmSync(project, { recursive: true, force: true });
}
