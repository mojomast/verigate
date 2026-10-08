# pornithi 🦅

> High-performance agent harness and long-horizon task orchestration for **Ornith-1.5-9B** (and small coding models) using the [Pi Coding Agent](https://github.com/badlogic/pi-mono).

---

## Overview

Small language models (7B–9B parameters) such as [Ornith-1.5-9B](https://huggingface.co/ornith-ai/Ornith-1.5-9B) are capable of competitive coding performance (scoring 70.6% on SWE-bench Verified and 46.2 on Terminal-Bench 2.1). However, in production agent loops they are prone to:

1. **Context Flooding:** Default harness output limits (often 50KB+ per tool call) burn through 30–40% of small context windows in a single command.
2. **Context Rot & Reasoning Degradation:** Extended multi-turn sessions degrade reasoning coherence as the prompt fills with noisy tool history.
3. **Looping & Hallucinated Progress:** Failing tool calls repeated without modification, and models prematurely grading their own work as "complete."
4. **Chat Template Mismatches:** Ornith-1.5 expects reasoning traces (`reasoning_content`) preserved across all historical assistant messages in `<think>` blocks, requiring exact template compatibility.

**`pornithi`** solves these challenges by offloading state, guardrails, and verification into the harness itself.

---

## Core Capabilities

### 1. Model & Chat Template Alignment
* **Exact Template Protocol:** Configured with `thinkingFormat: "qwen-chat-template"`, passing `chat_template_kwargs: { enable_thinking: true, preserve_thinking: true }`.
* **Preserved Reasoning in History:** `requiresReasoningContentOnAssistantMessages: true` guarantees replayed assistant messages include `reasoning_content` to match Ornith's training distribution.
* **Thinking Token Budgeting:** Uses `thinkingTokenBudgetField: "thinking_budget_tokens"` with budgets (1024–3072 tokens) to prevent reasoning from starving tool call output.
* **Sampling Profiles:** Calibrated according to the Ornith-1.5 model card:
  * *Precise coding:* `temperature: 0.6`, `top_p: 0.95`, `top_k: 20`, `presence_penalty: 0.0`, `repetition_penalty: 1.0`
  * *High-thinking / general tasks:* `temperature: 1.0`, `top_p: 0.95`

### 2. Guardrails (`small-model-guard.ts`)
* **Aggressive Output Budgets:** Replaces Pi's default 2,000 line / 50KB limit with a 120-line (~6KB) head-and-tail budget.
  * For shell commands (`bash`), retains 60% of the budget on the tail where compiler errors, stack traces, and test results live.
  * Spills complete output to disk (`/tmp/pi-spill-...`) and provides an actionable message with offset/limit instructions.
* **Empty Result Normalization:** Replaces silent command success with `(ok: the command ran successfully and produced no output)` to prevent the model from assuming a failure.
* **Automated Syntax Check on Edit:** Validates files (`.py`, `.js`, `.rb`, `.sh`, `.json`) immediately after `edit` or `write`. If syntax is broken, it marks the tool result as `isError: true` with the compiler diagnostics so the model immediately corrects the mistake.
* **Circuit Breaker:** Blocks identical calls that have failed twice, and terminates repeating loop patterns.

### 3. Long-Horizon Task Engine (`long-horizon/`)
* **TUI Integration:** Interactive slash commands inside Pi:
  * `/goal <description>`: Interactive planning session that breaks down a large goal into 3–8 atomic, verifiable steps, previews the plan in a modal, and begins execution.
  * `/run`: Resumes the saved plan from `.pi-plan/plan.json`.
  * `/tasks`: Displays the live checklist and recent progress log.
  * `/stop`: Gracefully stops the execution loop after the current turn.
* **Fresh Context per Task:** Each task runs in a clean session via `ctx.newSession({ withSession })`. The model only ever sees the overarching goal, a one-line roadmap, recent progress notes, and the single assigned task.
* **External Verification Gates:** Tasks declare a shell verification command (e.g. `npm test`, `pytest tests/test_feature.py`). The harness—not the model—executes this gate when `task_done` is invoked.
* **Git Checkpointing:** Automatically creates a clean git commit upon verification of each task.
* **Live TUI Widget:** Renders an interactive checklist widget above the editor and task progress indicators in the footer.

---

## Directory Structure

```text
pornithi/
├── agent/
│   ├── models.json                  # Provider, sampling params & compat flags
│   ├── settings.json                # Compact tools, thinking budgets, compaction
│   ├── APPEND_SYSTEM.md             # Lean operational guidelines for 9B models
│   └── extensions/
│       ├── small-model-guard.ts     # Truncation, syntax check, and circuit breaker
│       └── long-horizon/
│           ├── index.ts             # TUI slash commands, widgets & tool registrations
│           ├── plan-lib.mjs         # Durable state (.pi-plan), gates, git commits
│           └── run-plan.mjs         # Headless task driver
├── pi-ornith                        # Launcher for interactive Pi TUI
├── pi-plan                          # Headless runner for automated batch runs
└── README.md
```

---

## Getting Started

### Prerequisites

1. [Pi Coding Agent](https://github.com/badlogic/pi-mono):
   ```bash
   npm install -g @earendil-works/pi-coding-agent
   ```
2. Node.js (v20+)
3. An inference server running **Ornith-1.5-9B** (e.g., `llama-server` or `vLLM`) on `http://127.0.0.1:8080/v1`.

### 1. Launching the Model Server

#### Using `llama.cpp` (llama-server):
```bash
llama-server \
  -m /path/to/Ornith-1.5-9B-Q4_K_M.gguf \
  --alias ornith-1.5-9b \
  --jinja \
  --host 127.0.0.1 --port 8080 \
  -ngl 999 \
  -c 32768 \
  --flash-attn on \
  --temp 0.6 --top-p 0.95 --top-k 20
```

#### Using `vLLM`:
```bash
vllm serve ornith-ai/Ornith-1.5-9B \
  --port 8080 \
  --max-model-len 32768 \
  --enable-auto-tool-choice \
  --tool-call-parser qwen3_xml \
  --reasoning-parser qwen3
```

### 2. Interactive TUI Mode

Launch Pi with the custom Ornith environment:

```bash
./pi-ornith
```

Inside the session:
* Type `/goal Refactor database queries and add pagination` to plan and execute a multi-step task.
* Use `/tasks` to inspect progress.
* Use `/stop` to pause.

### 3. Headless / Unattended Mode

For automated overnight or background execution:

```bash
# Plan and execute
./pi-plan --goal "Implement OAuth2 callback handler with unit tests"

# Or resume an existing .pi-plan/plan.json
./pi-plan
```

---

## Configuration Reference

### `agent/settings.json` Highlights
| Setting | Value | Rationale |
|---|---|---|
| `defaultTools` | `["read", "edit", "write", "bash", "grep", "find"]` | Minimal, high-reliability tool surface for 9B models. |
| `defaultThinkingLevel` | `"low"` | Fast, focused reasoning without excessive token burn. |
| `compaction.reserveTokens` | `6144` | Tuned for 32k context windows (Pi default 16384 reserves half of 32k). |
| `compaction.keepRecentTokens` | `8000` | Preserves recent working turns while freeing space. |

### `agent/models.json` Highlights
| Field | Value | Purpose |
|---|---|---|
| `compat.thinkingFormat` | `"qwen-chat-template"` | Emits `chat_template_kwargs.enable_thinking` & `preserve_thinking`. |
| `compat.requiresReasoningContentOnAssistantMessages` | `true` | Preserves prior `<think>` blocks across turn history. |
| `compat.thinkingTokenBudgetField` | `"thinking_budget_tokens"` | Enforces reasoning token limits in inference requests. |
| `samplingParams` | `temp: 0.6, top_p: 0.95, top_k: 20` | Exact recommended settings from Ornith-1.5 model card. |

---

## License

MIT
