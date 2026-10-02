# Goal kernel experiment: execution and acceptance contract

This private Node package runs bounded Codex CLI turns for one local goal. It is
an experimental package, invoked explicitly from its source checkout. It is not
loaded by LoopX, registered as a built-in capability, shipped in the Python wheel,
or connected to the Dashboard or Lark. It does not drive Codex's native Goal API.
The package owns its local TypeScript state rules; Codex CLI is the execution
provider. No shared LoopX authority contract or second Python owner is introduced.

## Running the package

Requires Node 22.22.3 or newer, a working `codex` command and its existing login.
Verifier commands in the example also require Python 3. From this directory:

```bash
npm ci
npm run typecheck
npm test
node --experimental-strip-types src/cli.ts init --project ./examples/greeting --id greeting --spec ./examples/greeting/spec.json
node --experimental-strip-types src/cli.ts run --project ./examples/greeting --id greeting --turns 6
node --experimental-strip-types src/cli.ts status --project ./examples/greeting --id greeting
node --experimental-strip-types src/cli.ts view --project ./examples/greeting --id greeting
```

State, the declaration, receipts and the text view stay under the selected
project's ignored `.loopx/goal-kernel/` directory. Repeated `init` is rejected so
it cannot erase a goal's budget or acceptance. Use a new id for a new experiment.
The JSON spec's `goal_id` must match `--id`.

The runtime defaults to `workspace-write`. `--sandbox read-only` is available
for inspection tasks. Explicit `--sandbox danger-full-access` delegates the
current user's filesystem permissions to the subprocess; use only a disposable,
trusted environment when the usual sandbox is unavailable. This package does
not change Codex login, model, global settings or scheduling.
[Codex authentication](https://developers.openai.com/codex/auth) explains the
CLI's login storage. Check `codex login status` in the same environment used to
run the package; an inherited alternate configuration directory can select a
different login.

To stop using the experiment, stop invoking `run` and remove any external clock
entry you created. It installs no daemon. Preserve the goal directory for audit
or delete it with its disposable project. Removing the package has no effect on
LoopX's default runtime.

## Acceptance and progress

The owner supplies `objective`, `predicates`, `policy.max_turns` and
`policy.max_idle_turns`. Both limits must be positive integers. Predicate ids
are unique. Supported checks are `file_exists`, `file_sha256`, `command` and
`owner` (see `src/types.ts` and the example spec).

Before an admitted action, the kernel checks the declaration fingerprint,
todo references, file assumptions and pending objective amendments. It then
refreshes acceptance from the actual workspace so a resumed session sees
invalidated work. After the action it checks the declaration again, re-runs
all automatic predicates, updates todos, and settles the turn. Verifier commands
must be trusted, bounded, repeatable and read-only; they run at both boundaries
in the selected project and do not inherit the model subprocess's sandbox.

`verified_predicates` is the current snapshot. A failed automatic check removes
its earlier pass and reopens todos completed by that predicate. A check passing
for the first time earns progress; creating todos, repeating claims or repairing
an already credited checkpoint does not. `credited_predicates` retains that
history across restarts. Original v1 state without the optional field is read
with its earlier verified ids already credited. Neither logs nor old receipts
are rewritten during that read.

A complete acceptance snapshot wins over a just-reached turn or idle limit.
Declaration integrity, stale assumptions and pending owner decisions still win
over completion. An incomplete goal stops at its configured limit. Runtime
failures also consume an attempted turn; missing provider token usage is not an
estimate of zero cost.

No semantic relevance judgment is made from a todo's predicate id. Binding an id
only proves referential validity. Choose acceptance checks and intermediate
checkpoints that reflect the real desired outcome; a large task with no
checkable intermediate result can legitimately need a larger idle allowance.
A prompt hash identifies the explicit rendered prompt, not Codex's full session
history, tool inputs, workspace or a replayable execution.

## Readback and owner operations

`status` and `view` show the last recorded verification snapshot. `run` on a
completed goal rechecks it without a model call. Regression changes the state
to `stopped` with `acceptance_regressed`; it does not silently return success or
start new work. Exit codes: `0` means the requested bounded operation succeeded
(and can still leave the goal running), `3` means stopped, `1` means usage or
uncaught runtime error. Read `status` to distinguish running from done.

Only `owner` predicates may be accepted through
`accept --predicate ID --note TEXT`. Model claims cannot accept them. This is
an operator convention on a trusted local machine, not authenticated separation
between a human and an agent with the same filesystem permissions.

A returned objective amendment stops execution. `amend --confirm` adopts it;
`amend --reject` continues with the prior objective. The prototype updates only
the objective, not the predicate definitions. A change to acceptance or budgets
requires a new goal. General stopped-goal recovery is not automated: inspect the
reason and use a new goal after correcting the declaration or environment.

## Validation and remaining qualification

```bash
npm test
npm run typecheck
npm run test:live -- --sandbox workspace-write
```

Offline tests include positive and negative acceptance, repeated-credit and
budget-boundary cases, goal edits during a turn, restart readback, pending owner
decisions, legacy state and real CLI behavior. The live check spends model
tokens in a disposable synthetic project. It exercises five separate kernel
processes on one Codex session, an external regression and repair, completion
on the last turn, and rejection of a stale completed result. The task explicitly
requests one checkpoint per turn to exercise continuation.

This smoke is not evidence of multi-hour reliability or improved model quality.
The package has no concurrency fence, no transaction spanning journal and state,
no automatic network retry or general recovery command, and no guarantee of
reclaiming subprocess descendants after timeout. Token counters are observational;
provider cumulative-versus-delta accounting and cost have not been qualified.
The verifier and state are accessible to an agent with workspace write access.
There is no sandboxed independent judge or guarantee against semantic drift.

The next evaluation belongs to the existing
[long-horizon research program](../../docs/architecture/rfcs/long-horizon-harness-benchmark-research-program-v0.md):
compare pinned native and kernel runs on matched real tasks and budgets, with
independent final acceptance, recovery, idle spend, owner interventions and
uncertainty. This package's mechanism checks do not close that program's
capability-evidence acceptance or qualify any LoopX product entrypoint.
