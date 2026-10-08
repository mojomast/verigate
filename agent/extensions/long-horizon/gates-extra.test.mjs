// Offline tests for the three new gate capabilities:
//   1. --final-gate   : end-of-run criteria must not deadlock an implementation-first plan
//   2. .pi-gates.json : operator-owned acceptance contract, sealed against agent edits
//   3. planted mutation: does the suite actually constrain the code it exercises?
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPlan, completeTask, loadPlan, setExternalGates } from "./plan-lib.mjs";
import { contractGate, deriveGates, hashOracle, mutationGate } from "./derive-gates.mjs";

const results = [];
function check(label, actual, expected) {
	const pass = JSON.stringify(actual) === JSON.stringify(expected);
	results.push(pass);
	console.log(`  ${pass ? "PASS" : "FAIL"}  ${label.padEnd(52)} ${JSON.stringify(actual)}${pass ? "" : `  expected ${JSON.stringify(expected)}`}`);
}

const BASH = "C:\\Program Files\\Git\\bin\\bash.exe";
function repo() {
	const d = mkdtempSync(join(tmpdir(), "gates3-"));
	execFileSync("git", ["init", "-q"], { cwd: d });
	execFileSync("git", ["config", "user.email", "t@t.local"], { cwd: d });
	execFileSync("git", ["config", "user.name", "t"], { cwd: d });
	return d;
}
function sh(cwd, cmd) {
	return execFileSync(BASH, ["-c", cmd], { cwd, encoding: "utf8" });
}
function seedProject(d, { moduleSrc, testSrc }) {
	mkdirSync(join(d, "tests"), { recursive: true });
	writeFileSync(join(d, "mod.py"), moduleSrc, "utf8");
	writeFileSync(join(d, "tests", "test_mod.py"), testSrc, "utf8");
	sh(d, "git add -A && (git diff --cached --quiet || git commit -q -m base)");
	return d;
}

const GOOD_MODULE = "def add(a, b):\n    return a + b\n";
const GOOD_TEST = "import unittest, mod\n\nclass T(unittest.TestCase):\n    def test_add(self):\n        self.assertEqual(mod.add(2, 3), 5)\n";
// Assertion-free: touches the code, constrains nothing.
const HOLLOW_TEST = "import unittest, mod\n\nclass T(unittest.TestCase):\n    def test_smoke(self):\n        mod.add(1, 1)\n";

// ---- 1. final-gate semantics -------------------------------------------------
console.log("final-gate semantics:");
{
	const d = seedProject(repo(), { moduleSrc: GOOD_MODULE, testSrc: GOOD_TEST });
	// implementation-first plan: task 1 cannot pass the suite yet (mod is fine, but imagine not)
	const plan = createPlan(d, "two step", [
		{ title: "step one", verify: "test -f mod.py" },
		{ title: "step two", verify: "test -f mod.py" },
	]);
	let failing = "python -c \"raise SystemExit(1)\"";
	setExternalGates([{ kind: "command", cmd: failing, source: "final-only", final: true }]);
	const r1 = completeTask(d, 1, "");
	check("final gate NOT enforced on a non-final task", r1.ok, true);

	const plan2 = loadPlan(d);
	plan2.tasks[1].status = "pending";
	setExternalGates([{ kind: "command", cmd: failing, source: "final-only", final: true }]);
	const r2 = completeTask(d, 2, "");
	check("final gate IS enforced on the last task", r2.ok, false);
	check("  ...and it is reported as an ACCEPTANCE GATE failure", r2.message.includes("ACCEPTANCE GATE FAILED"), true);

	setExternalGates([{ kind: "command", cmd: 'python -c "print(1)"', source: "final-only", final: true }]);
	rmSync(d, { recursive: true, force: true });
}

// ---- 2. acceptance contract --------------------------------------------------
console.log("\n.pi-gates.json contract:");
{
	const d = seedProject(repo(), { moduleSrc: GOOD_MODULE, testSrc: GOOD_TEST });
	writeFileSync(join(d, ".pi-gates.json"), JSON.stringify({
		checks: [{ name: "mod imports", command: "python -c \"import mod\"", expect_exit: 0 }],
	}), "utf8");
	sh(d, "git add -A && (git diff --cached --quiet || git commit -q -m oracle)");

	const sealed = hashOracle(d);
	check("oracle hash is recorded", typeof sealed === "string" && sealed.length === 16, true);

	let g = contractGate(d, sealed);
	check("contract: passing check", g.run().ok, true);

	// A failing expectation must be reported. Re-seal first: with the OLD hash the gate would
	// (correctly) reject the edited oracle before it ever evaluated a check.
	writeFileSync(join(d, ".pi-gates.json"), JSON.stringify({
		checks: [{ name: "wrong", command: "python -c \"import mod\"", expect_exit: 3 }],
	}), "utf8");
	sh(d, "git add -A && git commit -q -m oracle2");
	g = contractGate(d, hashOracle(d));
	const r = g.run();
	check("contract: failing expectation is caught", r.ok, false);
	check("contract: names the failing check", r.out.includes("wrong"), true);

	// Rule 6: the agent must not be able to edit its own acceptance criteria.
	g = contractGate(d, sealed);
	const tampered = g.run();
	check("contract: agent edit to the oracle is rejected", tampered.ok, false);
	check("contract: says it was MODIFIED", tampered.out.includes("MODIFIED"), true);
	rmSync(d, { recursive: true, force: true });
}
{
	// stdout assertions: regex + golden file
	const d = seedProject(repo(), { moduleSrc: GOOD_MODULE, testSrc: GOOD_TEST });
	writeFileSync(join(d, ".pi-gates.json"), JSON.stringify({
		checks: [
			{ name: "regex", command: 'python -c "print(\'total: 5\')"', stdout_regex: "^total: 5$" },
			{ name: "golden", command: 'python -c "print(\'total: 5\')"', stdout_golden: "expected.txt" },
		],
	}), "utf8");
	writeFileSync(join(d, "expected.txt"), "total: 5\n", "utf8");
	let g = contractGate(d, hashOracle(d));
	check("contract: regex + golden both satisfied", g.run().ok, true);

	writeFileSync(join(d, "expected.txt"), "total: 6\n", "utf8");
	g = contractGate(d, hashOracle(d));
	const r = g.run();
	check("contract: golden mismatch is caught", r.ok, false);
	check("contract: diff is shown", r.out.includes("expected") && r.out.includes("total: 6"), true);
	rmSync(d, { recursive: true, force: true });
}

// ---- 3. planted mutation ----------------------------------------------------
console.log("\nplanted-mutation gate:");
{
	const d = seedProject(repo(), { moduleSrc: GOOD_MODULE, testSrc: GOOD_TEST });
	const g = mutationGate(d, ["mod.py"], { testCmd: "python -m unittest discover -s tests" });
	check("gate is created for a python project", Boolean(g), true);
	const r = g.run();
	check("meaningful tests KILL the planted mutations", r.ok, true);
	check("  ...reported as 100%", r.out.includes("mutation score 100%"), true);
	check("  ...and mod.py was restored", readFileSync(join(d, "mod.py"), "utf8"), GOOD_MODULE);
	rmSync(d, { recursive: true, force: true });
}
{
	const d = seedProject(repo(), { moduleSrc: GOOD_MODULE, testSrc: HOLLOW_TEST });
	const g = mutationGate(d, ["mod.py"], { testCmd: "python -m unittest discover -s tests" });
	const r = g.run();
	check("assertion-free tests SURVIVE the mutation", r.ok, false);
	check("  ...and are named", r.out.includes("mod.py:2"), true);
	check("  ...with the operator shown", r.out.includes("+ -> -"), true);
	check("  ...and mod.py was still restored", readFileSync(join(d, "mod.py"), "utf8"), GOOD_MODULE);
	rmSync(d, { recursive: true, force: true });
}
{
	// No python runner -> no mutation gate (never a silent pass, just not applicable)
	const d = seedProject(repo(), { moduleSrc: GOOD_MODULE, testSrc: GOOD_TEST });
	check("no mutation gate for a non-python test command", mutationGate(d, ["mod.py"], { testCmd: "npm test" }), null);
	check("no mutation gate when nothing changed", mutationGate(d, [], { testCmd: "python -m unittest discover -s tests" }), null);
	rmSync(d, { recursive: true, force: true });
}

const bad = results.filter((r) => !r).length;
console.log(`\n${results.length - bad}/${results.length} passed`);
process.exit(bad ? 1 : 0);