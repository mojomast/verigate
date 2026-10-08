#!/usr/bin/env node
// Driver for long-horizon work (Ralph-style loop): one task per FRESH pi process, state on disk.
//
//   run-plan.mjs --goal "Add CSV export to the report page"   # planning session, then execute
//   run-plan.mjs                                              # resume existing .pi-plan/plan.json
//   run-plan.mjs --init tasks.json                            # skip planning: {goal, tasks:[{title,verify}]}
//   flags: --dry-run (print prompts only)  --max-runs N (default 40)  --pi <cmd> (default "pi")
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildTaskPrompt, createPlan, hasBlocked, hasPlan, isFinished, loadPlan, nextTask, noteRunEnded, PLANNING_PROMPT, summary } from "./plan-lib.mjs";

const args = process.argv.slice(2);
const flag = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const has = (n) => args.includes(n);
const cwd = process.cwd();
const piCmd = flag("--pi", "pi");
const maxRuns = Number(flag("--max-runs", 40));
const dry = has("--dry-run");
const agentDir = process.env.PI_CODING_AGENT_DIR || resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function runPi(prompt) {
	if (dry) return console.log("----- PROMPT -----\n" + prompt + "\n------------------");
	// -p: non-interactive; --no-session: nothing carries over except what is on disk
	const r = spawnSync(piCmd, ["-p", "--no-session", prompt], { cwd, stdio: "inherit", env: { ...process.env, PI_CODING_AGENT_DIR: agentDir } });
	if (r.error) throw r.error;
}

// 1. Plan
if (has("--init")) {
	const spec = JSON.parse(readFileSync(flag("--init"), "utf8"));
	createPlan(cwd, spec.goal, spec.tasks, { force: true });
} else if (has("--goal")) {
	const goal = flag("--goal");
	runPi(PLANNING_PROMPT(goal));
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
