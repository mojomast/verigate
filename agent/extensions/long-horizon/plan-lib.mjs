// Shared long-horizon state logic. Used by the Pi extension (index.ts) and the driver (run-plan.mjs).
// State lives on disk in <cwd>/.pi-plan/: plan.json (task contract) and progress.md (append-only log).
// JSON, not markdown: models treat prose as editable and JSON as a contract.
import { execSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const MAX_ATTEMPTS = 3; // failed verifications / empty runs before a task is auto-blocked
export const VERIFY_TIMEOUT_MS = 180_000;
const MAX_TASKS = 12;

const dir = (cwd) => join(cwd, ".pi-plan");
const planPath = (cwd) => join(dir(cwd), "plan.json");
const logPath = (cwd) => join(dir(cwd), "progress.md");

export function hasPlan(cwd) {
	return existsSync(planPath(cwd));
}

export function loadPlan(cwd) {
	return JSON.parse(readFileSync(planPath(cwd), "utf8"));
}

export function savePlan(cwd, plan) {
	mkdirSync(dir(cwd), { recursive: true });
	writeFileSync(planPath(cwd), JSON.stringify(plan, null, 2) + "\n");
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
	savePlan(cwd, plan);
	log(cwd, `PLAN created: ${plan.goal} (${plan.tasks.length} tasks)`);
	return plan;
}

export const nextTask = (plan) => plan.tasks.find((t) => t.status === "pending");
export const isFinished = (plan) => plan.tasks.every((t) => t.status === "done");

export function summary(plan) {
	const mark = { done: "[x]", pending: "[ ]", blocked: "[!]" };
	return plan.tasks.map((t) => `${mark[t.status]} ${t.id}. ${t.title}`).join("\n");
}

function runVerify(cwd, cmd) {
	try {
		const out = execSync(cmd, { cwd, stdio: "pipe", timeout: VERIFY_TIMEOUT_MS, encoding: "utf8", shell: "/bin/bash" });
		return { ok: true, out };
	} catch (e) {
		const out = `${e.stdout || ""}\n${e.stderr || ""}`.trim() || String(e.message);
		return { ok: false, out: out.split("\n").slice(-25).join("\n") }; // tail only: errors are at the end
	}
}

function commit(cwd, msg) {
	if (!existsSync(join(cwd, ".git"))) return;
	try {
		execSync(`git add -A -- . ':!.pi-plan' && git commit -q -m ${JSON.stringify(msg)}`, { cwd, stdio: "pipe", shell: "/bin/bash" });
	} catch {
		/* nothing to commit, or no git identity: not fatal */
	}
}

/** Verification gate: the harness, not the model, decides if a task is done. */
export function completeTask(cwd, id, notes = "") {
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
	t.status = "done";
	t.notes = String(notes).slice(0, 300);
	savePlan(cwd, plan);
	log(cwd, `task ${t.id} DONE: ${t.title}${t.notes ? ` | ${t.notes}` : ""}`);
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

export const PLANNING_PROMPT = (goal) =>
	`GOAL: ${goal}\n\nPlan only; do NOT implement. Briefly inspect the project (find/grep/read), then call plan_create ONCE with 3-8 small ordered tasks. ` +
	`Each task: one concrete change that touches few files. Give each task a verify shell command that exits 0 only when it is done (run tests, build, grep for the symbol, test -f file). ` +
	`Make the last task a full test/build run. Then stop.`;
