// Shared long-horizon state logic. Used by the Pi extension (index.ts) and the driver (run-plan.mjs).
// State lives on disk in <cwd>/.pi-plan/: plan.json (task contract) and progress.md (append-only log).
// JSON, not markdown: models treat prose as editable and JSON as a contract.
import { execSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hashOracle, deriveGates } from "./derive-gates.mjs";

export const MAX_ATTEMPTS = 3; // failed verifications / empty runs before a task is auto-blocked
export const VERIFY_TIMEOUT_MS = 180_000;
const MAX_TASKS = 12;

// Windows: task verify commands are POSIX-flavoured (`test -f`, `grep -q`), so run them under
// Git Bash rather than cmd.exe. `bash` alone resolves to the WSL launcher in system32, which
// would silently target a different filesystem root than the rest of the harness.
const GIT_BASH = "C:\\Program Files\\Git\\bin\\bash.exe";
const SHELL = process.platform === "win32" ? (existsSync(GIT_BASH) ? GIT_BASH : undefined) : "/bin/bash";
const shellOption = SHELL ? { shell: SHELL } : {};

// Acceptance criteria owned by the harness, not the model.
// Research on agent "reward hacking" (METR RE-Bench: 30.4% of runs; 100% on one task family)
// shows a model asked to grade its own work will author a gate weak enough to pass its own
// mistakes -- and prompt instructions to "don't cheat" have near-zero effect. Gates come from
// the operator (--gate) and from derive-gates.mjs (auto-detected), and are ANDed with the
// model's own task gate, so "done" can never mean only "the model agrees with itself".
//
// A gate is either a plain command string or { cmd } / { run(): {ok, out}, source, soft }.
let externalGates = [];

export function setExternalGates(list) {
	externalGates = (list ?? [])
		.map((g) => (typeof g === "string" ? { kind: "command", cmd: g.trim(), source: "operator --gate" } : g))
		.filter((g) => g && (typeof g.run === "function" || (g.cmd && String(g.cmd).trim())));
}

export function describeGates() {
	return externalGates.map((g) => (g.cmd ?? `[${g.kind}] ${g.source ?? ""}`));
}

// Gates are re-derived before every task check, not once at plan time. An implementation-first
// plan has no tests/ directory when the plan is created, so a one-shot derivation would never
// find a canonical gate and the suite would go unenforced for the whole run. Re-deriving means
// newly-appeared test infrastructure starts binding the moment it exists.
let gateRefresher = null;

export function setGateRefresher(fn) {
	gateRefresher = typeof fn === "function" ? fn : null;
}

/** Gates that only prove the file parses / imports -- satisfiable by code full of `pass`. */
const WEAK_VERIFY = /\bast\.parse\b|py_compile|node\s+--check|--version\b|\bcompileall\b/;

export function weakVerifyReason(cmd) {
	if (!cmd) return "no verify command at all";
	if (!WEAK_VERIFY.test(cmd)) return null;
	return "looks like a syntax-only check (satisfiable by an empty implementation)";
}

/** Stable identity for a gate across processes, used to detect a repeatedly-failing gate. */
const gateKey = (gate) => gate.cmd ?? `${gate.kind}:${gate.source ?? "?"}`;

const dir = (cwd) => join(cwd, ".pi-plan");
const planPath = (cwd) => join(dir(cwd), "plan.json");
const logPath = (cwd) => join(dir(cwd), "progress.md");

export function hasPlan(cwd) {
	return existsSync(planPath(cwd));
}

export function loadPlan(cwd) {
	// Strip a UTF-8 BOM: plan.json edited by Windows PowerShell (`Set-Content -Encoding UTF8`)
	// carries one, and JSON.parse rejects it.
	return JSON.parse(readFileSync(planPath(cwd), "utf8").replace(/^﻿/, ""));
}

export function savePlan(cwd, plan) {
	mkdirSync(dir(cwd), { recursive: true });
	writeFileSync(planPath(cwd), JSON.stringify(plan, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// Gates must be armed in the process that DECIDES, which is the Pi subprocess running the
// long-horizon extension -- not the driver. The driver derives them once and persists the
// options here; the extension re-arms from this file before every task check. Without this
// handoff the harness silently runs ungated and only the model's own weak `verify` applies.
// ---------------------------------------------------------------------------
const gateOptsPath = (cwd) => join(dir(cwd), "gate-options.json");

export function saveGateOptions(cwd, opts) {
	mkdirSync(dir(cwd), { recursive: true });
	writeFileSync(gateOptsPath(cwd), JSON.stringify(opts ?? {}, null, 2) + "\n");
}

/** Derive and arm the gate set for `cwd`. Called by the driver AND by the extension. */
export function armGatesForPlan(cwd, opts) {
	let o = opts;
	if (!o) {
		try {
			o = JSON.parse(readFileSync(gateOptsPath(cwd), "utf8").replace(/^﻿/, ""));
		} catch {
			o = {};
		}
	}
	let plan = {};
	try {
		plan = loadPlan(cwd);
	} catch {
		/* no plan yet: derive what we can */
	}
	const { gates, notes } = deriveGates(cwd, {
		explicit: o.explicit ?? [],
		final: o.final ?? [],
		auto: o.auto !== false,
		base: plan.base ?? null,
		oracleHash: plan.oracleHash ?? null,
		mutation: o.mutation ?? null,
	});
	setExternalGates(gates);
	setGateRefresher(() => armGatesForPlan(cwd, o));
	return { gates, notes };
}

export function log(cwd, line) {
	mkdirSync(dir(cwd), { recursive: true });
	appendFileSync(logPath(cwd), `- ${new Date().toISOString().slice(0, 16)} ${line}\n`);
}

export function progressTail(cwd, n = 12) {
	if (!existsSync(logPath(cwd))) return "(no progress yet)";
	return readFileSync(logPath(cwd), "utf8").trim().split("\n").slice(-n).join("\n");
}

/** tasks: [{ title, verify? }]. Returns the plan. Refuses to overwrite an unfinished plan. */
export function createPlan(cwd, goal, tasks, { force = false } = {}) {
	if (!force && hasPlan(cwd) && loadPlan(cwd).tasks.some((t) => t.status === "pending" || t.status === "blocked")) {
		throw new Error("A plan with unfinished tasks already exists. Finish it or ask the user to delete .pi-plan/.");
	}
	if (!Array.isArray(tasks) || tasks.length === 0) throw new Error("Provide at least one task.");
	if (tasks.length > MAX_TASKS) throw new Error(`Too many tasks (${tasks.length}). Use at most ${MAX_TASKS}; make each one small but meaningful.`);
	const plan = {
		goal: String(goal).trim(),
		tasks: tasks.map((t, i) => {
			if (!t || !String(t.title || "").trim()) throw new Error(`Task ${i + 1} needs a title.`);
			return { id: i + 1, title: String(t.title).trim(), verify: t.verify ? String(t.verify).trim() : "", status: "pending", attempts: 0, notes: "" };
		}),
	};
	// Remember what the tree looked like before any task ran, so the harness can later compute
	// exactly which files the agent changed and require that those files are actually exercised.
	plan.base = (() => {
		try {
			return execSync("git rev-parse HEAD", { cwd, stdio: "pipe", encoding: "utf8", ...shellOption }).trim() || null;
		} catch {
			return null;
		}
	})();
	// Seal the acceptance contract. The implementing agent never owns the oracle: if it edits
	// .pi-gates.json mid-run, every contract gate fails until the file is restored.
	plan.oracleHash = hashOracle(cwd);
	savePlan(cwd, plan);
	log(cwd, `PLAN created: ${plan.goal} (${plan.tasks.length} tasks)`);
	log(cwd, `git base: ${plan.base ?? "(not a git repo -- changed-file gates disabled)"}`);
	log(cwd, `oracle: ${plan.oracleHash ? `.pi-gates.json sealed at ${plan.oracleHash}` : "none (no .pi-gates.json)"}`);
	// Surface model-authored gates that cannot fail. Cheap heuristic, logged only -- it never
	// blocks, because "file exists" and "grep for a symbol" are legitimately weak-but-fine for
	// scaffolding tasks. The real teeth are the harness-supplied gates.
	for (const t of plan.tasks) {
		const why = weakVerifyReason(t.verify);
		if (why) log(cwd, `WARNING task ${t.id} gate is weak -- ${why}: ${t.verify || "(none)"}`);
	}
	if (externalGates.length) log(cwd, `acceptance gates (harness-owned, must all pass): ${describeGates().join("  &&  ")}`);
	return plan;
}

export const nextTask = (plan) => plan.tasks.find((t) => t.status === "pending");

/** Clear an unsatisfiable (parked) task so a later resume can retry it. */
export function unblockTask(cwd, id, reason = "") {
	const plan = loadPlan(cwd);
	const t = plan.tasks.find((x) => x.id === Number(id));
	if (!t) throw new Error(`No task ${id}.`);
	t.status = "pending";
	t.attempts = 0;
	t.notes = reason ? `requeued: ${String(reason).slice(0, 200)}` : t.notes;
	savePlan(cwd, plan);
	log(cwd, `task ${t.id} requeued to pending${reason ? `: ${reason}` : ""}`);
	return plan;
}
export const isFinished = (plan) => plan.tasks.every((t) => t.status === "done");

export function summary(plan) {
	const mark = { done: "[x]", pending: "[ ]", blocked: "[!]", unsatisfiable: "[~]" };
	return plan.tasks.map((t) => `${mark[t.status]} ${t.id}. ${t.title}`).join("\n");
}

function runVerify(cwd, cmd) {
	try {
		const out = execSync(cmd, { cwd, stdio: ["ignore", "pipe", "pipe"], timeout: VERIFY_TIMEOUT_MS, encoding: "utf8", ...shellOption });
		return { ok: true, out };
	} catch (e) {
		// Test runners report on stderr (unittest prints its summary there), so a gate that only
		// surfaced stdout told the model "FAILED" with no explanation of what actually went wrong.
		const out = `${e.stdout || ""}${e.stderr || ""}`.trim() || String(e.message);
		return { ok: false, out: out.split("\n").slice(-25).join("\n") }; // tail only: errors are at the end
	}
}

function commit(cwd, msg) {
	if (!existsSync(join(cwd, ".git"))) return;
	try {
		// The ':!.pi-plan' pathspec makes `git add` fail (exit 1) when .pi-plan is also listed
		// in .gitignore: git refuses explicit ignored pathspecs. Fall back to a plain `add -A`,
		// which still skips .pi-plan because gitignore applies. Without this, any project that
		// ignores .pi-plan silently loses every checkpoint.
		execSync(`git add -A -- . ':!.pi-plan' 2>/dev/null || git add -A -- .`, { cwd, stdio: "pipe", ...shellOption });
		execSync(`git commit -q -m ${JSON.stringify(msg)}`, { cwd, stdio: "pipe", ...shellOption });
	} catch {
		/* nothing to commit, or no git identity: not fatal */
	}
}

/** Verification gate: the harness, not the model, decides if a task is done. */
export function completeTask(cwd, id, notes = "") {
	gateRefresher?.();
	const plan = loadPlan(cwd);
	const t = plan.tasks.find((x) => x.id === Number(id));
	if (!t) throw new Error(`No task ${id}. Valid ids: ${plan.tasks.map((x) => x.id).join(", ")}.`);
	if (t.status === "done") return { ok: true, message: `Task ${t.id} is already done.`, plan };
	if (t.verify) {
		const v = runVerify(cwd, t.verify);
		if (!v.ok) {
			t.attempts += 1;
			if (t.attempts >= MAX_ATTEMPTS) t.status = "blocked";
			savePlan(cwd, plan);
			log(cwd, `task ${t.id} verify FAILED (attempt ${t.attempts})`);
			return {
				ok: false,
				message: `VERIFICATION FAILED for task ${t.id} (attempt ${t.attempts}/${MAX_ATTEMPTS}). Command: ${t.verify}\n${v.out}\n` +
					(t.status === "blocked" ? "Task is now BLOCKED. Stop and report." : "Fix the cause, then call task_done again."),
				plan,
			};
		}
	}
	// Gates marked `final` only bind once this is the last open task. This mirrors the PRE-gate /
	// POST-gate split used by task-spec and AgentSpec: some acceptance criteria cannot hold until
	// the work is finished (the full suite, an end-to-end command), so enforcing them on every
	// task would deadlock an implementation-first plan on its very first step.
	// A task that could not be verified because a gate could not pass yet should not hold up the
	// rest of the plan: treat it as done-for-purposes-of-final-gates, but record it honestly.
	const openAfterThis = plan.tasks.filter((x) => x.id !== t.id && x.status !== "done").length;
	const isFinalTask = openAfterThis === 0;
	const activeGates = externalGates.filter((g) => !g.final || isFinalTask);
	// A gate that fails identically on consecutive attempts is usually not "the work is wrong" --
	// it is "this gate cannot pass yet" (e.g. an end-of-run criterion enforced per-task). Burning
	// every attempt on it blocks a task for no reason and teaches the model that gates are noise.
	const history = plan.gateHistory ?? [];
	const IDENTICAL_LIMIT = 2;
	plan.gateHistory = history;
	for (const gate of activeGates) {
		const key = gateKey(gate);
		const label = gate.cmd ?? `[${gate.kind}] ${gate.source ?? "harness gate"}`;
		const priorFails = history.filter((h) => h.gate === key && h.ok === false).length;
		const stalled = priorFails >= IDENTICAL_LIMIT;
		let g;
		try {
			g = typeof gate.run === "function" ? gate.run({ finalTask: isFinalTask, plan, task: t }) : runVerify(cwd, gate.cmd);
		} catch (e) {
			g = { ok: false, out: String(e.stderr || e.stdout || e.message).trim().split("\n").slice(-25).join("\n") };
		}
		// A gate that cannot run reports UNVERIFIED. It must never be silently counted as a pass.
		if (g.unverified) {
			log(cwd, `task ${t.id} gate UNVERIFIED (${label}): ${g.out}`);
			continue;
		}
		history.push({ gate: key, ok: g.ok, task: t.id, final: isFinalTask });
		if (history.length > 60) history.splice(0, history.length - 60);
		if (!g.ok) {
			t.attempts += 1;
			// A gate that has now failed the same way `IDENTICAL_LIMIT` times is treated as
			// unsatisfiable for THIS task: the task is parked, not blocked, and no more attempts
			// are burned on a criterion this task structurally cannot satisfy.
			if (stalled) {
				t.status = "unsatisfiable";
				savePlan(cwd, plan);
				log(cwd, `task ${t.id} UNSATISFIABLE gate (${priorFails} identical failures): ${label}`);
				return {
					ok: false,
					unsatisfiable: true,
					message:
						`ACCEPTANCE GATE CANNOT PASS YET for task ${t.id}: ${label}\n` +
						`This gate has failed ${priorFails + 1} times in a row with the same result, so retrying is pointless.\n${g.out}\n` +
						"This is usually a criterion that can only be satisfied once OTHER tasks are done, not a defect in your work.\n" +
						"Stop here and report: name which gate blocks you and what it needs. Do not modify the contract or the gates.",
					plan,
				};
			}
			if (t.attempts >= MAX_ATTEMPTS) t.status = "blocked";
			savePlan(cwd, plan);
			log(cwd, `task ${t.id} FAILED acceptance gate (attempt ${t.attempts}): ${label}`);
			return {
				ok: false,
				message:
					`ACCEPTANCE GATE FAILED for task ${t.id} (attempt ${t.attempts}/${MAX_ATTEMPTS}). ` +
					`This gate is owned by the harness, not by you:\n  ${label}\n${g.out}\n` +
					"Your own task check may have passed; that is not sufficient. " +
					(t.status === "blocked" ? "Task is now BLOCKED. Stop and report." : "Fix the cause, then call task_done again."),
				plan,
			};
		}
	}
	t.status = "done";
	t.notes = String(notes).slice(0, 300);
	savePlan(cwd, plan);
	const finalNote = isFinalTask ? " [final task: end-of-run gates enforced]" : "";
	log(cwd, `task ${t.id} DONE: ${t.title}${t.notes ? " | " + t.notes : ""}${finalNote}`);
	commit(cwd, `task ${t.id}: ${t.title}`);
	const nxt = nextTask(plan);
	return {
		ok: true,
		message: `Task ${t.id} verified and marked done.` + (nxt ? ` Next up: task ${nxt.id}. STOP NOW; the next task starts in a fresh session.` : " All tasks are done. Give a brief final summary."),
		plan,
	};
}

export function blockTask(cwd, id, reason = "") {
	const plan = loadPlan(cwd);
	const t = plan.tasks.find((x) => x.id === Number(id));
	if (!t) throw new Error(`No task ${id}.`);
	t.status = "blocked";
	t.notes = String(reason).slice(0, 300);
	savePlan(cwd, plan);
	log(cwd, `task ${t.id} BLOCKED: ${t.notes}`);
	return plan;
}

/** The only context a worker session gets: goal, one-line map, recent log, ONE task. */
export function buildTaskPrompt(cwd, plan, task) {
	return [
		`GOAL: ${plan.goal}`,
		``,
		`PLAN:`,
		summary(plan),
		``,
		`RECENT PROGRESS:`,
		progressTail(cwd),
		``,
		`YOUR TASK (only this one): ${task.id}. ${task.title}`,
		task.verify ? `It counts as done when this passes: ${task.verify}` : `No automatic check; verify your work yourself.`,
		task.attempts ? `Previous attempts failed: ${task.attempts}. Check the progress log and the code before changing anything.` : ``,
		``,
		`Rules: work only on this task. Inspect before editing. When finished call task_done with task_id=${task.id} and a one-line note.`,
		`If it cannot be done, call task_blocked with the reason. Do not start other tasks.`,
	].filter((l) => l !== null).join("\n");
}

export function resetPlan(cwd) {
	if (hasPlan(cwd)) rmSync(planPath(cwd));
	log(cwd, "PLAN reset");
}

/** Called after a worker session ends. If the model never called task_done and the gate did not run, count a failed attempt. */
export function noteRunEnded(cwd, id, attemptsBefore) {
	const plan = loadPlan(cwd);
	const t = plan.tasks.find((x) => x.id === Number(id));
	if (t && t.status === "pending" && t.attempts === attemptsBefore) {
		t.attempts += 1;
		log(cwd, `task ${t.id} ended without task_done (attempt ${t.attempts})`);
		if (t.attempts >= MAX_ATTEMPTS) {
			t.status = "blocked";
			t.notes = "gave up: repeatedly ended without completing";
		}
		savePlan(cwd, plan);
	}
	return plan;
}

export const hasBlocked = (plan) => plan.tasks.some((t) => t.status === "blocked");
export const hasIncomplete = (plan) => plan.tasks.some((t) => t.status === "pending");
export const hasUnsatisfiable = (plan) => plan.tasks.some((t) => t.status === "unsatisfiable");

export const PLANNING_PROMPT = (goal) =>
	`GOAL: ${goal}\n\nPlan only; do NOT implement. Briefly inspect the project (find/grep/read), then call plan_create ONCE with 3-8 small ordered tasks. ` +
	`Each task: one concrete change that touches few files. Give each task a verify shell command that exits 0 only when it is done (run tests, build, grep for the symbol, test -f file). ` +
	`Make the last task a full test/build run. Then stop.`;
