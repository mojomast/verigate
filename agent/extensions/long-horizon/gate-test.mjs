// Offline test: does an operator-owned --gate override a model-authored weak gate?
// Exercises plan-lib.completeTask with a plan whose OWN verify passes, then checks the
// outcome with (a) a failing operator gate and (b) a passing operator gate.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { completeTask, setExternalGates } from "./plan-lib.mjs";

const PASSING_GATE = 'python -c "print(1)"'; // exactly the kind of gate a model writes for itself
const FAILING_GATE = 'python -c "raise SystemExit(1)"';

function makeRepo(verify) {
	const d = mkdtempSync(join(tmpdir(), "gate-test-"));
	mkdirSync(join(d, ".pi-plan"), { recursive: true });
	writeFileSync(
		join(d, ".pi-plan", "plan.json"),
		JSON.stringify({
			goal: "test",
			tasks: [{ id: 1, title: "t1", verify, status: "pending", attempts: 0, notes: "" }],
		}),
		"utf8",
	);
	return d;
}

function run(label, gates, verify) {
	const d = makeRepo(verify);
	setExternalGates(gates);
	const r = completeTask(d, 1, "note");
	const state = JSON.parse(readFileSync(join(d, ".pi-plan", "plan.json"), "utf8")).tasks[0];
	console.log(`--- ${label}`);
	console.log(`    ok=${r.ok}  status=${state.status}  attempts=${state.attempts}`);
	console.log(`    msg: ${r.message.split("\n")[0].slice(0, 105)}`);
	rmSync(d, { recursive: true, force: true });
	return { ok: r.ok, state };
}

const a = run("A. no operator gate, model gate passes", [], PASSING_GATE);
const b = run("B. operator gate FAILS (model gate passes)", [FAILING_GATE], PASSING_GATE);
const c = run("C. operator gate passes", [PASSING_GATE], PASSING_GATE);

console.log("\nRESULT:");
console.log(`  A marked done with no operator gate : ${a.ok}  (expected true - documents the gap)`);
console.log(`  B blocked by operator gate          : ${!b.ok}  (expected true - this is the fix)`);
console.log(`  C done when both gates pass         : ${c.ok}  (expected true)`);
process.exit(a.ok && !b.ok && c.ok ? 0 : 1);