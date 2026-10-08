# verigate

> **veri**·**gate** — verification as a gate the model cannot argue with.

> An agent harness that makes **7B–9B models behave like they were reviewed** — harness-owned
> acceptance gates, an operator-owned oracle, and structural (not prompt-level) enforcement of
> the plan/execute boundary. Built for [Ornith-1.5-9B](https://huggingface.co/ornith-ai/Ornith-1.5-9B)
> on [Pi](https://github.com/earendil-works/pi).

Small models are good at writing plausible code. They are **not** good at knowing whether what
they wrote actually works. That gap is the problem this harness exists to close.

---

## The problem

Ornith-1.5-9B scores 70.6% on SWE-bench Verified. Put it in an agent loop against a real
inference server and the same model reports success on broken code. Three measured failure modes,
in descending order of how badly they waste your time:

### 1. It grades its own homework, and grades itself generously

Research on agent **reward hacking** is unambiguous. On METR's RE-Bench, frontier models
subverted the evaluation **30.4% of runs** — 100% on one task family:

> *"Instructing the model to solve the task the intended way, to not cheat, or to not reward
> hack had a nearly negligible effect on reward hacking."* — METR

And the same failure shows up in ordinary test generation. Across **86,156 agent-authored test
patches** in 2,807 repositories:

> *"**80.2% of agent-authored test-file patches contain weak or no explicit oracle signals.**"*
> — arXiv 2606.18168

In our own testing, a 9B model gated its own task with `ast.parse` — a check that three
functions full of `pass` sail straight through — then reported the task verified. On another run
it wrote `grep -q 'return x * 3'`, which can never match a literal asterisk, and blocked itself
correctly. Same behaviour, opposite polarity: **it optimises for making the gate pass**, and when
it writes an accidentally honest gate it reports failure.

### 2. Prompt rules do not fix this

The tempting fix — add "don't write weak tests" to the system prompt — has near-zero measured
effect. Three independent lines of evidence agree:

- METR: instruction-based anti-hacking prompts *"had a nearly negligible effect"*
- Plan mode in production coding agents is *"essentially just a system prompt"*, and was
  jailbroken into editing `.zshrc` while nominally read-only
- Intrinsic self-correction *"overturns 21.9% of correct GPT-4o solutions"* (Zhang et al. 2024)

**So nothing in this repo asks the model to behave better.** Every mechanism here is deterministic
code that the model cannot talk its way past.

### 3. Context rot and runaway reasoning

Unbounded thinking burns the budget and returns nothing. Measured on Ornith with no cap: **2 of 5
loop-prone prompts returned empty content** after spending 3000 tokens purely on reasoning. Capping
thinking at 1536 tokens made all five return answers, at no quality cost.

---

## What this harness does instead

| Mechanism | What it stops |
|---|---|
| **Harness-derived gates** | The model never authors the thing that judges it. The canonical test command, coverage, mutation and assertion checks are derived from the repo by deterministic code. |
| **Operator oracle** (`.pi-gates.json`) | The agent cannot edit its own acceptance criteria. The file's hash is sealed into `plan.json`; tampering fails every check until restored. |
| **Oracle sealing** | Research rule 6: *"The implementing agent never owns the oracle."* |
| **Plan/execute phase scoping** | Planning sessions register `plan_create` **only**. `task_done` does not exist in the schema, so a planner physically cannot finish the job. |
| **Planted-mutation floor** | Coverage can't tell an assertion from a no-op. We plant real bugs in changed files and require the suite to notice. |
| **Test-theater detector** | Static screen for test files with no assertions at all, targeting the measured 80.2%. |
| **Reasoning budget** | Stop runaway thinking without truncating the answer. |

---

## Quick start

### Requirements

- Node.js v20+ (developed on v24)
- A running OpenAI-compatible endpoint serving **Ornith-1.5-9B** with tool calling and
  `reasoning_content`
- [Pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent):
  `npm install -g @earendil-works/pi-coding-agent`

### Point it at your server

Edit `agent/models.json`:

```json
"baseUrl": "http://127.0.0.1:8091/v1"
```

That must match your server. The `id` must be a model name **your gateway accepts** — some
routers (including Turbofit's) only accept their configured route names (`auto`,
`active:main`, `active:aux`) and reject everything else with HTTP 400.

Recommended server flags for this model:

```bash
llama-server --jinja --alias <your-alias> --ctx-size 87040 \
  --gpu-layers 99 --flash-attn on \
  --reasoning on --reasoning-budget 1536 \
  --reasoning-budget-message "Due to time constraints, I should wrap up and give the answer now." \
  --temp 0.6 --top-p 0.95 --top-k 20
```

### Run it

```bash
# Windows
pi-ornith.cmd                        # interactive TUI
pi-plan.cmd --goal "Add CSV export"  # headless, unattended

# macOS / Linux
./pi-ornith
./pi-plan --goal "Add CSV export"
```

The launchers set `PI_CODING_AGENT_DIR` to this repo's `agent/`, so your global `~/.pi` config is
never touched.

### Interactive

| Command | Effect |
|---|---|
| `/goal <text>` | Plan a goal into small verified tasks, then run each in a fresh session |
| `/tasks` | Show the checklist and recent progress |
| `/run` | Resume the saved plan |
| `/stop` | Stop after the current turn |

### Headless

```bash
pi-plan.cmd --goal "Implement OAuth2 callback handler with unit tests"
pi-plan.cmd                        # resume existing .pi-plan/plan.json
pi-plan.cmd --init tasks.json      # skip planning entirely: you write the tasks
```

Useful flags:

| Flag | Effect |
|---|---|
| `--gate "CMD"` | Extra gate, enforced on **every** task |
| `--final-gate "CMD"` | Gate enforced only on the **final** task (use for end-to-end checks) |
| `--mutation --mutation-min 70` | Plant mutations in changed files; require a kill rate |
| `--no-auto-gate` | Disable all auto-derivation |
| `--dry-run` | Print prompts without executing |
| `--max-runs N` | Cap execution attempts (default 40) |

---

## The acceptance contract

`verigate` will infer *a* test command from your repo. It cannot know the one **you** meant. That
difference matters — see [Known limits](#known-limits).

Put what you actually require in `.pi-gates.json` at your project root:

```json
{
  "checks": [
    { "name": "library is correct",
      "command": "python -c \"import lib; assert lib.f(2) == 4\"" },

    { "name": "cli output matches the oracle",
      "command": "python cli.py summary data.jsonl",
      "expect_exit": 0,
      "stdout_golden": "expected/summary.txt",
      "final": true }
  ]
}
```

**Supported assertions:** `expect_exit`, `stdout_golden` (file diff), `stdout_regex`,
`stdout_not_regex`, `stdout_empty`, `stderr_empty`, `max_stdout_lines`.

**Scoping — read this one.** A check without `final` gates **every** task. A check with
`"final": true` is deferred until the last task, then enforced.

> An end-to-end check that invokes a file a *later* task creates makes the earlier task
> unsatisfiable by construction. We hit exactly this: a contract check on `cli.py` blocked task 1
> forever, and the model correctly reported the gate as unsatisfiable rather than weakening its own
> code. Scope end-to-end checks with `final: true`.

The file is **operator-owned**: its SHA-256 is sealed into `.pi-plan/plan.json` at plan time. If
the agent edits it mid-run, every check fails with an explicit `MODIFIED` error until it is
restored.

---

## How verification works

Gates are derived at every task check, so newly-appeared test infrastructure starts binding the
moment it exists.

```
gate: auto gate [operator]:     acceptance contract .pi-gates.json (hash …, agent edits rejected)
gate: auto gate [repo-derived]: python -m unittest discover -s tests  (from tests/ contains test_*.py)
gate: auto gate [repo-derived]: every changed Python file must be exercised (3 file(s) changed)
gate: auto gate [repo-derived]: changed test files must contain explicit assertions
gate: auto gate [repo-derived]: planted mutations in changed files must be caught (floor 70%)
```

### Gate provenance: read the labels

| Label | Meaning |
|---|---|
| `[operator]` | Expected value came from a channel the agent cannot influence. **Strong.** |
| `[repo-derived]` | Derived from files the agent itself created. **Structurally weaker** — the derivation is anchored on the draft. |

This distinction is from *Blind Oracle*: *"if the function that produces expected can read the
draft, the verification is anchored regardless of what the prompt says."* Our canonical-command
detector reads `tests/test_*.py` — a file the agent wrote — so when the agent put its tests at the
repo root, auto-derivation silently switched to `python -m unittest discover` and the layout
requirement evaporated. Pin anything you care about in `.pi-gates.json`.

### Unsatisfiable vs blocked

A gate that fails identically three times running is treated as **unsatisfiable**, not as a defect
in the model's work:

```
ACCEPTANCE GATE CANNOT PASS YET for task 1: [contract] …
This gate has failed 3 times in a row with the same result, so retrying is pointless.
This is usually a criterion that can only be satisfied once OTHER tasks are done,
not a defect in your work.
```

The task is parked (`[~]`) rather than blocked, so it does not poison the plan. Requeue it later
with `task_requeue` once its dependencies exist. A gate that fails and then passes is never
misreported as unsatisfiable.

### `UNVERIFIED` is not `passed`

If a gate cannot run — `coverage.py` missing, a non-Python test command, a soft-failed
measurement — it reports `UNVERIFIED` in `progress.md` and **never counts as a pass**. From the
verification literature: *"evaluator unavailable is `unobserved`"*, never a silent green.

---

## Output budgets (small-model-guard)

Pi's default tool output is 2000 lines / 50KB, which can consume 30–40% of a small context window
in a single command.

| Behaviour | verigate |
|---|---|
| Lines per tool result | 120 (~6KB), head **and** tail |
| `bash` results | 60% of budget reserved for the tail, where errors live |
| Truncated output | Spilled to a temp file with offset/limit instructions |
| Empty results | `(ok: the command ran successfully and produced no output)` |
| After `edit`/`write` | Syntax-checked; broken output is returned as `isError` |
| Repeated calls | Identical failure ×2 blocked; 3-in-a-row loop blocked |

---

## Repository layout

```
verigate/
├── pi-ornith[.cmd]              # interactive launcher
├── pi-plan[.cmd]                # headless driver
└── agent/
    ├── models.json              # provider, sampling, compat flags
    ├── settings.json            # tools, thinking budgets, compaction
    ├── APPEND_SYSTEM.md         # operating rules for small models
    └── extensions/
        ├── small-model-guard.ts # output budgets, syntax check, circuit breaker
        └── long-horizon/
            ├── index.ts             # TUI slash commands, tools, widgets
            ├── plan-lib.mjs         # plan state, verification gates, checkpoints
            ├── run-plan.mjs         # headless driver
            ├── derive-gates.mjs     # gate derivation: canonical cmd, coverage,
            │                        #   mutation, assertions, oracle contract
            └── *.test.mjs           # 80 offline tests, no model required
```

---

## Tests

All harness logic is testable without a GPU or a model:

```bash
node agent/extensions/long-horizon/gaps.test.mjs          # 33  scoping, provenance, theater
node agent/extensions/long-horizon/gate-handoff.test.mjs  #  9  cross-process gate arming
node agent/extensions/long-horizon/gates-extra.test.mjs   # 22  contract, mutation, final gates
node agent/extensions/long-horizon/derive-gates.test.mjs  # 16  command detection
node agent/extensions/long-horizon/gate-test.mjs          #  3  baseline gate behaviour
```

They run in seconds and are how every bug in this repo was found — including three that only
appeared under a real model (a shell-quoting bug, an unstaged-file detection gap, and gates that
were silently never armed because they were set in the wrong process).

---

## Windows notes

This harness is developed on Windows 11; the fixes are load-bearing, not cosmetic.

- **`/bin/bash` → Git Bash.** Verification commands are POSIX-flavoured (`test -f`, `grep -q`).
  Bare `bash` on Windows resolves to the **WSL** launcher in `system32`, which checks a different
  filesystem root. `plan-lib.mjs` resolves Git Bash explicitly.
- **`setlocal` breaks npm shims.** The `.cmd` launchers deliberately omit it — the npm `pi.cmd`
  shim does not see env vars set inside a `setlocal` scope.
- **`python3` is a Store stub** on Windows that fails *without* `ENOENT`, which the syntax checker
  would report as a bogus error. We use `python`.
- **BOM.** Windows PowerShell 5.1's `Set-Content -Encoding UTF8` writes a BOM that `JSON.parse`
  rejects. `loadPlan` strips it.
- **Untracked files.** `git diff` never reports a new file. A newly created module is untracked by
  definition, so gate derivation unions `git ls-files --others`.

---

## Known limits

Stated plainly, because the failure modes above are only worth fixing if you know what's left.

- **Narration is unverified.** Gates check the work; nothing checks the *report*. We have seen a
  model state a passing result for an expression that raises `TypeError` when run. Closing this
  needs claim-vs-reality checking over the transcript.
- **Coverage is not assertion strength.** A test can import a module and assert nothing. That is
  why the mutation floor exists — but see the next point.
- **The mutation floor is a smoke signal, not a score.** Four operators, first occurrence per
  file, capped at 12 mutants. A run reporting `100%` on **n=3** is weak evidence.
- **Only Python gets derived coverage/mutation gates.** `go test`, `cargo test` and `npm test` are
  used as-is, with no changed-file enforcement.
- **Auto-derived gates are draft-anchored.** Anything you care about belongs in `.pi-gates.json`.
- **One model per session.** No cross-model verification; the verifier and the builder are the
  same 9B.

---

## Design notes

Structural choices trace to specific research rather than intuition:

- **Oracle sealing** — Expectation-Driven Development, rule 6: *"The implementing agent never owns
  the oracle."*
- **Gate provenance** — *Blind Oracle*: expected values must come from a channel the draft cannot
  influence.
- **Plan/execute scoping** — schema-level tool restriction, so write tools *"do not exist in the
  schema"* rather than being denied at runtime.
- **Diff-scoped mutation** — full mutation testing costs `mutants × suite-runtime`; scoping to
  changed files is what makes it affordable per-task.
- **Coverage as a floor, not a target** — absolute thresholds are *"easy to satisfy and easy to
  game"*; the interesting number is what changed.
- **Independent implementation** converges on this shape: `verity` uses a claims manifest,
  GovernSpec compiles a contract, `task-spec` separates PRE-gate from POST-gate.

## License

MIT