import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const cli = new URL("../src/cli.ts", import.meta.url).pathname;
function fixture(t: test.TestContext) {
  const project = mkdtempSync(join(tmpdir(), "gk-cli-"));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  const spec = {
    goal_id: "g", objective: "Create a; then obtain owner acceptance.",
    predicates: [
      { id: "a", statement: "a exists", verify: { kind: "file_exists", path: "a" } },
      { id: "owner", statement: "owner accepts", verify: { kind: "owner", note: "review" } },
    ], policy: { max_turns: 1, max_idle_turns: 2 },
  };
  const specPath = join(project, "spec.json");
  writeFileSync(specPath, JSON.stringify(spec));
  const statePath = join(project, ".loopx", "goal-kernel", "goals", "g", "state.json");
  function run(verb: string, args: string[] = []) {
    const r = spawnSync(process.execPath, ["--no-warnings", "--experimental-strip-types", cli,
      verb, "--project", project, "--id", "g", ...args], { encoding: "utf8", timeout: 5000 });
    assert.equal(r.error, undefined);
    return { code: r.status, text: `${r.stdout}${r.stderr}` };
  }
  return { project, spec, specPath, statePath, run };
}

test("CLI init cannot erase an existing goal's budget and acceptance", t => {
  const h = fixture(t);
  assert.equal(h.run("init", ["--spec", h.specPath]).code, 0);
  const before = readFileSync(h.statePath, "utf8");
  const second = h.run("init", ["--spec", h.specPath]);
  assert.equal(second.code, 1);
  assert.match(second.text, /already exists/);
  assert.equal(readFileSync(h.statePath, "utf8"), before);
});

test("CLI rejects malformed budgets, duplicate predicates and invalid turn limits", t => {
  const h = fixture(t);
  for (const max_turns of [0, -1, 1.5, null, "many"]) {
    writeFileSync(h.specPath, JSON.stringify({ ...h.spec, policy: { ...h.spec.policy, max_turns } }));
    assert.equal(h.run("init", ["--spec", h.specPath]).code, 1);
  }
  writeFileSync(h.specPath, JSON.stringify({ ...h.spec, predicates: [h.spec.predicates[0], h.spec.predicates[0]] }));
  assert.match(h.run("init", ["--spec", h.specPath]).text, /unique/);
  for (const turns of ["0", "-1", "1.5", "NaN", "2suffix"]) {
    assert.match(h.run("run", ["--turns", turns]).text, /positive integer/);
  }
});

test("CLI owner acceptance cannot bypass automatic checks; completion and regression read back", t => {
  const h = fixture(t);
  assert.equal(h.run("init", ["--spec", h.specPath]).code, 0);
  assert.equal(h.run("accept", ["--predicate", "a"]).code, 1);
  writeFileSync(join(h.project, "a"), "ok");
  assert.equal(h.run("accept", ["--predicate", "owner"]).code, 0);
  // Already satisfied work is verified and settled without launching a model.
  assert.equal(h.run("run").code, 0);
  assert.match(h.run("status").text, /status=done/);
  assert.match(h.run("view").text, /\[x\] \*\*a\*\*/);
  rmSync(join(h.project, "a"));
  const invalidated = h.run("run");
  assert.equal(invalidated.code, 3, invalidated.text);
  assert.match(invalidated.text, /acceptance_regressed/);
  assert.equal(h.run("status").code, 3);
  assert.match(h.run("view").text, /\[ \] \*\*a\*\*/);
  assert.equal(JSON.parse(readFileSync(h.statePath, "utf8")).turn_count, 0);
});
