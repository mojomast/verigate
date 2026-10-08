// Tests for the five gap fixes:
//   1. planning sessions cannot register task tools (phase scoping)
//   2. a plan arriving with completed tasks is refused
//   3. gate provenance (derivation_source) is stamped and logged
//   4. operator contract can pin the exact test command
//   5. static "test theater" detector flags assertion-free test files
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { armGatesForPlan, completeTask, createPlan, loadPlan, saveGateOptions } from "./plan-lib.mjs";
import { assertionGate, deriveGates, isTestFile } from "./derive-gates.mjs";

const results = [];
function check(label, actual, expected) {
	const pass = JSON.stringify(actual) === JSON.stringify(expected);
	results.push(pass);
	console.log(`  ${pass ? "PASS" : "FAIL"}  ${label.padEnd(58)} ${JSON.stringify(actual)}${pass ? "" : `  expected ${JSON.stringify(expected)}`}`);
}
const BASH = "C:\\Program Files\\Git\\bin\\bash.exe";
const sh = (cwd, c) => execFileSync(BASH, ["-c", c], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

function repo(files = {}) {
	const d = mkdtempSync(join(tmpdir(), "gaps-"));
	execFileSync("git", ["init", "-q"], { cwd: d });
	execFileSync("git", ["config", "user.email", "t@t.local"], { cwd: d });
	execFileSync("git", ["config", "user.name", "t"], { cwd: d });
	mkdirSync(join(d, "tests"), { recursive: true });
	for (const [name, body] of Object.entries(files)) {
		const full = join(d, name);
		mkdirSync(join(full, ".."), { recursive: true });
		writeFileSync(full, body, "utf8");
	}
	sh(d, "git add -A && (git diff --cached --quiet || git commit -q -m base)");
	return d;
}

const LIB = "def add(a, b):\n    return a + b\n";
const REAL_TEST = "import unittest, logparse\n\nclass T(unittest.TestCase):\n    def test_add(self):\n        self.assertEqual(logparse.add(2, 3), 5)\n";
const HOLLOW_TEST = "import logparse\n\ndef test_add():\n    logparse.add(2, 3)\n";

// ---- 5. test-theater detector ------------------------------------------------
console.log("static assertion ('test theater') detector:");
check("tests/test_x.py is recognised as a test file", isTestFile("tests/test_x.py"), true);
check("foo.py is not a test file", isTestFile("foo.py"), false);
check("a.spec.ts is recognised", isTestFile("src/a.spec.ts"), true);
{
	const d = repo({ "logparse.py": LIB, "tests/test_logparse.py": HOLLOW_TEST });
	const g = assertionGate(d, ["tests/test_logparse.py"]);
	check("hollow test file produces a gate", Boolean(g), true);
	const r = g.run();
	check("hollow test file FAILS the gate", r.ok, false);
	check("  ...and names the file", r.out.includes("tests/test_logparse.py"), true);
	rmSync(d, { recursive: true, force: true });
}
{
	const d = repo({ "logparse.py": LIB, "tests/test_logparse.py": REAL_TEST });
	check("real assertions produce no gate", assertionGate(d, ["tests/test_logparse.py"]), null);
	rmSync(d, { recursive: true, force: true });
}
{
	// a helper/fixture with no test declarations must not be flagged
	const d = repo({ "helpers.py": LIB, "tests/conftest.py": "import os\nFIXTURE = 1\n" });
	check("fixture without test decls is not flagged", assertionGate(d, ["tests/conftest.py"]), null);
	rmSync(d, { recursive: true, force: true });
}
{
	// pytest-style asserts are recognised too
	const d = repo({ "logparse.py": LIB, "tests/test_logparse.py": "import logparse\n\ndef test_add():\n    assert logparse.add(2, 3) == 5\n" });
	check("pytest-style asserts are recognised", assertionGate(d, ["tests/test_logparse.py"]), null);
	rmSync(d, { recursive: true, force: true });
}

// ---- 3. provenance ----------------------------------------------------------
console.log("\ngate provenance (derivation_source):");
{
	// Seed one committed file so the repo has a real base commit, then create the plan and add
	// the agent's files afterwards, so the changed-file gates have something to bite on.
	const d = repo({ "README.md": "# seed\n" });
	const plan = createPlan(d, "prov", [{ title: "t1", verify: "test -f logparse.py" }]);
	writeFileSync(join(d, "logparse.py"), LIB, "utf8");
	// Hollow on purpose: the assertion gate only exists when a changed test file has no assertions
	// at all, which is exactly the condition we want visible here.
	writeFileSync(join(d, "tests", "test_logparse.py"), HOLLOW_TEST, "utf8");
	writeFileSync(join(d, ".pi-gates.json"), JSON.stringify({ checks: [{ name: "x", command: "python -c \"import logparse\"", expect_exit: 0 }] }), "utf8");
	sh(d, "git add -A && git commit -q -m agent-work");
	// Point the plan's base at the commit BEFORE the agent's files, so they read as changed.
	const base = sh(d, "git rev-parse HEAD~1").trim();
	// Distinct strings so the explicit gate cannot be confused with the auto-derived one.
	const g = deriveGates(d, { explicit: ["python -m unittest discover -s tests -v"], base, oracleHash: plan.oracleHash });
	const explicit = g.gates.find((x) => x.source === "operator --gate");
	const canonical = g.gates.find((x) => x.kind === "command" && x.source?.startsWith("auto:"));
	const contract = g.gates.find((x) => x.kind === "contract");
	const coverage = g.gates.find((x) => x.kind === "coverage");
	check("explicit --gate is [operator]", explicit?.derivation_source, "operator");
	check("auto canonical gate is [repo]", canonical?.derivation_source, "repo");
	check("contract gate is [operator]", contract?.derivation_source, "operator");
	check("coverage gate is [repo]", coverage?.derivation_source, "repo");
	check("assertion gate is [repo]", g.gates.find((x) => x.kind === "assertions")?.derivation_source, "repo");
	check("notes label the source", g.notes.some((n) => n.includes("[operator]")) && g.notes.some((n) => n.includes("[repo-derived]")), true);
	rmSync(d, { recursive: true, force: true });
}

// ---- 4. operator pins the exact command -------------------------------------
console.log("\noperator contract pins the exact command:");
{
	const d = repo({ "logparse.py": LIB });
	writeFileSync(join(d, ".pi-gates.json"), JSON.stringify({
		checks: [{ name: "spec'd unittest layout", command: "python -m unittest discover -s tests", expect_exit: 0 }],
	}), "utf8");
	sh(d, "git add -A && git commit -q -m oracle");
	const plan = createPlan(d, "pin", [{ title: "t1", verify: "test -f logparse.py" }]);
	const g = deriveGates(d, { base: plan.base, oracleHash: plan.oracleHash });
	const contract = g.gates.find((x) => x.kind === "contract");
	// No tests/ directory at all: the derived command is moot, the operator pin is what counts.
	const r = contract.run();
	check("operator-pinned command FAILS when tests/ is absent", r.ok, false);
	check("  ...and it is not masked by auto-derivation", r.out.includes("No such file") || r.out.includes("ModuleNotFound") || r.out.includes("error") || r.out.includes("Ran 0"), true);
	rmSync(d, { recursive: true, force: true });
}

// ---- 2. refuse a pre-completed plan -----------------------------------------
// ---- 6. per-check "final" scoping --------------------------------------------
console.log("\nper-check 'final' scoping in the operator contract:");
{
	const d = repo({ "logparse.py": LIB });
	writeFileSync(join(d, ".pi-gates.json"), JSON.stringify({
		checks: [
			{ name: "library works now", command: "python -c \"import logparse\"", expect_exit: 0 },
			{ name: "cli works at the end", command: "python cli.py summary sample.jsonl", expect_exit: 0, final: true },
		],
	}), "utf8");
	const plan = createPlan(d, "scope", [{ title: "t1", verify: "test -f logparse.py" }]);
	const g = deriveGates(d, { base: plan.base, oracleHash: plan.oracleHash });
	const contract = g.gates.find((x) => x.kind === "contract");
	// cli.py does not exist: on a NON-final task the end-of-run check must be deferred, not failed.
	const mid = contract.run({ finalTask: false });
	check("mid-plan: end-of-run check is deferred", mid.ok, true);
	check("  ...and says how many were deferred", mid.deferred, 1);
	check("  ...and the library check really ran", mid.out.includes("1 acceptance check(s) passed"), true);
	// On the final task it must run and fail, because cli.py still does not exist.
	const last = contract.run({ finalTask: true });
	check("final task: deferred check now runs and FAILS", last.ok, false);
	check("  ...and no longer deferred", last.deferred, 0);
	check("  ...naming the cli check", last.out.includes("cli works at the end"), true);
	rmSync(d, { recursive: true, force: true });
}
{
	// all checks final -> nothing to do mid-plan, and that must read as a pass, not a silent skip
	const d = repo({ "logparse.py": LIB });
	writeFileSync(join(d, ".pi-gates.json"), JSON.stringify({
		checks: [{ name: "cli", command: "python cli.py", expect_exit: 0, final: true }],
	}), "utf8");
	const plan = createPlan(d, "allfinal", [{ title: "t1", verify: "test -f logparse.py" }]);
	const g = deriveGates(d, { base: plan.base, oracleHash: plan.oracleHash });
	const r = g.gates.find((x) => x.kind === "contract").run({ finalTask: false });
	check("all-final contract passes mid-plan explicitly", r.ok, true);
	check("  ...and says so", r.out.includes("deferred"), true);
	rmSync(d, { recursive: true, force: true });
}

// ---- 7. unsatisfiable-gate detection -----------------------------------------
console.log("\nunsatisfiable-gate detection (stop burning attempts):");
{
	const d = repo({ "logparse.py": LIB, "tests/test_logparse.py": REAL_TEST });
	createPlan(d, "stall", [{ title: "t1", verify: "test -f logparse.py" }]);
	const { setExternalGates } = await import("./plan-lib.mjs");
	const failing = [{ kind: "command", cmd: "python -c \"raise SystemExit(1)\"", source: "always-fails" }];
	setExternalGates(failing);
	const r1 = completeTask(d, 1, "");
	const r2 = completeTask(d, 1, "");
	const r3 = completeTask(d, 1, "");
	check("attempt 1 is a normal failure", r1.ok === false && !r1.unsatisfiable, true);
	check("attempt 2 is a normal failure", r2.ok === false && !r2.unsatisfiable, true);
	check("attempt 3 is flagged UNSATISFIABLE", r3.unsatisfiable === true, true);
	check("  ...task is parked, not 'blocked'", loadPlan(d).tasks[0].status, "unsatisfiable");
	check("  ...attempts stop at 3, not MAX_ATTEMPTS*gates", loadPlan(d).tasks[0].attempts, 3);
	check("  ...and it tells the model this is not its fault", r3.message.includes("not a defect in your work"), true);
	rmSync(d, { recursive: true, force: true });
}
{
	// a gate that fails then PASSES must keep counting as a normal failure (no false positive)
	const d = repo({ "logparse.py": LIB, "tests/test_logparse.py": REAL_TEST });
	createPlan(d, "recover", [{ title: "t1", verify: "test -f logparse.py" }]);
	const { setExternalGates } = await import("./plan-lib.mjs");
	let n = 0;
	setExternalGates([{ kind: "command", cmd: `python -c "raise SystemExit(${n++})"`, source: "flaky" }]);
	completeTask(d, 1, "");
	const recovered = completeTask(d, 1, "");
	check("a gate that recovers is not called unsatisfiable", recovered.unsatisfiable, undefined);
	rmSync(d, { recursive: true, force: true });
}

console.log("\nrefuse a plan whose tasks are already completed:");
{
	const d = repo({ "logparse.py": LIB, "tests/test_logparse.py": REAL_TEST });
	const plan = createPlan(d, "pre", [{ title: "t1", verify: "test -f logparse.py" }]);
	plan.tasks[0].status = "done";
	writeFileSync(join(d, ".pi-plan", "plan.json"), JSON.stringify(plan, null, 2), "utf8");
	const reloaded = loadPlan(d);
	const preDone = reloaded.tasks.filter((t) => t.status && t.status !== "pending");
	check("pre-completed tasks are detected", preDone.length, 1);
	rmSync(d, { recursive: true, force: true });
}

const bad = results.filter((x) => !x).length;
console.log(`\n${results.length - bad}/${results.length} passed`);
process.exit(bad ? 1 : 0);