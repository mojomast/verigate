#!/usr/bin/env node
// Driver for long-horizon work (Ralph-style loop): one task per FRESH pi process, state on disk.
//
//   run-plan.mjs --goal "Add CSV export to the report page"   # planning session, then execute
//   run-plan.mjs                                              # resume existing .pi-plan/plan.json
//   run-plan.mjs --init tasks.json                            # skip planning: {goal, tasks:[{title,verify}]}
//   flags: --dry-run (print prompts only)  --max-runs N (default 40)  --pi <cmd> (default "pi")
//          --gate "CMD" (repeatable)  operator-owned acceptance gate, ANDed with every task's own gate
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { armGatesForPlan, buildTaskPrompt, createPlan, hasBlocked, hasPlan, isFinished, loadPlan, nextTask, noteRunEnded, PLANNING_PROMPT, saveGateOptions, summary } from "./plan-lib.mjs";
import { deriveGates } from "./derive-gates.mjs";

const args = process.argv.slice(2);
const flag = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const has = (n) => args.includes(n);
const cwd = process.cwd();
const piCmd = flag("--pi", "pi");

// Windows: `pi` on PATH is an npm shim, not an executable. Node >= 18 refuses to spawn
// .cmd/.bat without a shell (EINVAL), and shell:true would re-split the multi-line task
// prompt on its own quotes. Resolve Pi's JS entry point and run it with node instead, so
// the prompt stays a single argv element.
function resolvePi() {
	if (piCmd !== "pi" || process.platform !== "win32") return { file: piCmd, prefix: [] };
	const root = process.env.APPDATA && join(process.env.APPDATA, "npm", "node_modules", "@earendil-works", "pi-coding-agent");
	if (!root) return { file: piCmd, prefix: [] };
	try {
		const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
		const rel = typeof pkg.bin === "string" ? pkg.bin : Object.values(pkg.bin ?? {})[0];
		if (!rel) return { file: piCmd, prefix: [] };
		return { file: process.execPath, prefix: [resolve(root, rel)] };
	} catch {
		return { file: piCmd, prefix: [] };
	}
}
const maxRuns = Number(flag("--max-runs", 40));
const dry = has("--dry-run");
// Gates the model never authors: operator --gate commands, plus gates the harness derives from
// the repo itself (its canonical test command, and "every file you changed must be exercised").
const explicitGates = args.reduce((acc, a, i) => (a === "--gate" ? [...acc, args[i + 1]] : acc), []);
const finalGates = args.reduce((acc, a, i) => (a === "--final-gate" ? [...acc, args[i + 1]] : acc), []);
const mutation = has("--mutation") ? { min: Number(flag("--mutation-min", 60)), max: Number(flag("--mutation-max", 12)) } : null;
const autoGates = !has("--no-auto-gate");

/** Persist the gate options, then derive+arm. The Pi subprocess re-arms from the same file. */
function installGates() {
	try {
		saveGateOptions(cwd, { explicit: explicitGates, final: finalGates, auto: autoGates, mutation });
	} catch {
		/* before .pi-plan exists: the post-plan call persists them */
	}
	const { notes } = armGatesForPlan(cwd, { explicit: explicitGates, final: finalGates, auto: autoGates, mutation });
	for (const n of notes) console.log(`gate: ${n}`);
	return notes;
}

if (explicitGates.length || autoGates) {
	// Before a plan exists there is no base yet; derive what we can so a dry run shows the gates.
	installGates();
}
const agentDir = process.env.PI_CODING_AGENT_DIR || resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function runPi(prompt, phase = "execute") {
	if (dry) return console.log("----- PROMPT -----\n" + prompt + "\n------------------");
	// -p: non-interactive; --no-session: nothing carries over except what is on disk
	const { file, prefix } = resolvePi();
	// PI_PHASE scopes which tools the extension registers: the planning session gets plan_create
	// only, so it cannot call task_done and complete the work before the execution loop starts.
	const r = spawnSync(file, [...prefix, "-p", "--no-session", prompt], {
		cwd,
		stdio: "inherit",
		env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_PHASE: phase },
	});
	if (r.error) throw r.error;
}

// 1. Plan
if (has("--init")) {
	const spec = JSON.parse(readFileSync(flag("--init"), "utf8"));
	createPlan(cwd, spec.goal, spec.tasks, { force: true });
} else if (has("--goal")) {
	const goal = flag("--goal");
	runPi(PLANNING_PROMPT(goal), "plan");
	if (!dry && !hasPlan(cwd)) {
		console.error("Planning produced no plan. Re-run, or write a tasks.json and use --init.");
		process.exit(1);
	}
}
if (dry && !hasPlan(cwd)) process.exit(0);
if (!hasPlan(cwd)) {
	console.error('No .pi-plan/plan.json. Use --goal "..." or --init tasks.json.');
	process.exit(1);
}

// Persist + arm now that the plan exists: the recorded git base is what makes the
// "every file you changed must be exercised" gate possible, and the sealed oracle hash is
// what lets the contract gate reject agent edits to its own acceptance criteria.
installGates();

// Defence in depth for the phase scoping above: a plan whose tasks already carry results means
// something marked work done outside the execution loop. Refuse rather than run a plan that was
// never actually executed.
{
	const p = loadPlan(cwd);
	const preDone = (p.tasks ?? []).filter((t) => t.status && t.status !== "pending");
	if (preDone.length) {
		const kinds = [...new Set(preDone.map((t) => t.status))].join("/");
		console.error(
			`Refusing to run: ${preDone.length} task(s) are already marked ${kinds} before the execution loop started.\n` +
				`A plan must be created with every task pending. Delete .pi-plan/ and re-run, or reset those tasks to "pending".`,
		);
		process.exit(1);
	}
}

// 2. Execute: fresh process per task; harness (not model) decides progress
for (let run = 1; run <= maxRuns; run++) {
	let plan = loadPlan(cwd);
	const task = nextTask(plan);
	if (!task) break;
	console.log(`\n=== run ${run}: task ${task.id}/${plan.tasks.length}: ${task.title} ===`);
	const attemptsBefore = task.attempts;
	runPi(buildTaskPrompt(cwd, plan, task));
	if (dry) break;
	noteRunEnded(cwd, task.id, attemptsBefore);
	if (hasBlocked(loadPlan(cwd))) break;
}

const final = loadPlan(cwd);
console.log("\n" + summary(final));
console.log(isFinished(final) ? "\nALL TASKS DONE." : "\nStopped with unfinished tasks. See .pi-plan/progress.md; fix or edit plan.json, then re-run to resume.");
process.exit(isFinished(final) ? 0 : 2);
