// Proves the gate handoff across the process boundary: the driver persists gate options, and a
// SEPARATE process (standing in for the Pi subprocess running the extension) must arm the same
// gates and have them block. Reproduces the real-world mismatch that slipped through: the agent
// wrote pytest-style tests while the derived canonical gate is stdlib unittest.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPlan, saveGateOptions } from "./plan-lib.mjs";

// The child script stands in for the Pi subprocess. Kept next to this file so the path is
// portable rather than hardcoded to one machine.
const CHILD = fileURLToPath(new URL("./gate-child.mjs", import.meta.url));
const results = [];
function check(label, actual, expected) {
	const pass = JSON.stringify(actual) === JSON.stringify(expected);
	results.push(pass);
	console.log(`  ${pass ? "PASS" : "FAIL"}  ${label.padEnd(56)} ${JSON.stringify(actual)}${pass ? "" : `  expected ${JSON.stringify(expected)}`}`);
}
const BASH = "C:\\Program Files\\Git\\bin\\bash.exe";
const sh = (cwd, c) => execSync(c, cwd);

function repo({ testSrc }) {
	const d = mkdtempSync(join(tmpdir(), "handoff-"));
	execFileSync("git", ["init", "-q"], { cwd: d });
	execFileSync("git", ["config", "user.email", "t@t.local"], { cwd: d });
	execFileSync("git", ["config", "user.name", "t"], { cwd: d });
	mkdirSync(join(d, "tests"), { recursive: true });
	writeFileSync(join(d, "logparse.py"), "def add(a, b):\n    return a + b\n", "utf8");
	writeFileSync(join(d, "tests", "test_logparse.py"), testSrc, "utf8");
	sh(d, "git add -A && git commit -q -m base");
	return d;
}
function execSync(c, cwd) {
	return execFileSync(BASH, ["-c", c], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
function child(cwd, id = 1) {
	const out = execFileSync("node", [CHILD, cwd, String(id)], { encoding: "utf8" });
	const grab = (k) => (out.match(new RegExp(`^${k}: (.*)$`, "m")) ?? [])[1];
	return { armed: grab("ARMED"), ok: grab("OK"), status: grab("STATUS"), msg: grab("MSG"), full: out };
}

const UNITTEST_TESTS = `import unittest, logparse\n\nclass T(unittest.TestCase):\n    def test_add(self):\n        self.assertEqual(logparse.add(2, 3), 5)\n`;
const PYTEST_TESTS = `import logparse\n\ndef test_add():\n    assert logparse.add(2, 3) == 5\n`;

console.log("cross-process gate handoff:");
{
	// pytest-style tests, no pytest config -> canonical gate is stdlib unittest -> 0 tests, exit 5
	const d = repo({ testSrc: PYTEST_TESTS });
	createPlan(d, "handoff", [{ title: "t1", verify: "test -f logparse.py" }]);
	saveGateOptions(d, { explicit: [], final: [], auto: true, mutation: null });
	const r = child(d);
	check("child process armed the canonical gate", r.armed.includes("unittest discover"), true);
	check("child BLOCKED on the vacuous-suite gate", r.ok, "false");
	check("  ...task left pending", r.status, "pending");
	check("  ...reason names NO TESTS RAN", /NO TESTS RAN/.test(r.full), true);
	rmSync(d, { recursive: true, force: true });
}
{
	// real unittest tests -> suite green -> the task completes
	const d = repo({ testSrc: UNITTEST_TESTS });
	createPlan(d, "handoff", [{ title: "t1", verify: "test -f logparse.py" }]);
	saveGateOptions(d, { explicit: [], final: [], auto: true, mutation: null });
	const r = child(d);
	check("child armed gates", r.armed.includes("unittest discover"), true);
	check("child completed the task when the suite is real", r.ok, "true");
	check("  ...status done", r.status, "done");
	rmSync(d, { recursive: true, force: true });
}
{
	// No persisted options: auto-derivation still applies (it needs no options file -- that is the
	// point of auto-gates); only explicit/final/mutation are opt-in and therefore absent.
	const d = repo({ testSrc: PYTEST_TESTS });
	createPlan(d, "handoff", [{ title: "t1", verify: "test -f logparse.py" }]);
	const r = child(d);
	check("without an options file, auto gates are still derived", r.armed.includes("unittest discover"), true);
	check("  ...but no explicit gate is invented", /(^|\| )python -c/.test(r.armed), false);
	rmSync(d, { recursive: true, force: true });
}

const bad = results.filter((x) => !x).length;
console.log(`\n${results.length - bad}/${results.length} passed`);
process.exit(bad ? 1 : 0);