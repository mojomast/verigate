// Offline tests for derive-gates.mjs: does the harness pick the right canonical gate for
// each project shape, and does it stay quiet when it cannot verify anything?
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { detectCanonicalGate, deriveGates } from "./derive-gates.mjs";

const results = [];
function check(label, actual, expected) {
	const pass = actual === expected;
	results.push(pass);
	console.log(`  ${pass ? "PASS" : "FAIL"}  ${label.padEnd(46)} ${actual ?? "(null)"}${pass ? "" : `   expected: ${expected}`}`);
}

function fixture(files) {
	const d = mkdtempSync(join(tmpdir(), "derive-"));
	for (const [name, body] of Object.entries(files)) {
		const full = join(d, name);
		mkdirSync(join(full, ".."), { recursive: true });
		writeFileSync(full, body, "utf8");
	}
	return d;
}

console.log("canonical test-command detection:");
let d;
d = fixture({ "Makefile": "test:\n\tpytest -q\nbuild:\n\techo build\n" });
check("Makefile with test target", detectCanonicalGate(d)?.cmd, "make test");
rmSync(d, { recursive: true, force: true });

d = fixture({ "package.json": JSON.stringify({ scripts: { test: "vitest run" } }) });
check("package.json scripts.test=vitest", detectCanonicalGate(d)?.cmd, "npx vitest run test");
rmSync(d, { recursive: true, force: true });

d = fixture({ "package.json": JSON.stringify({ scripts: { test: "jest" } }) });
check("package.json scripts.test=jest", detectCanonicalGate(d)?.cmd, "npx jest test");
rmSync(d, { recursive: true, force: true });

d = fixture({ "pyproject.toml": "[project]\nname='x'\n\n[tool.pytest.ini_options]\ntestpaths=['tests']\n" });
check("pyproject [tool.pytest]", detectCanonicalGate(d)?.cmd, "python -m pytest -q");
rmSync(d, { recursive: true, force: true });

d = fixture({ "pytest.ini": "[pytest]\n" });
check("pytest.ini", detectCanonicalGate(d)?.cmd, "python -m pytest -q");
rmSync(d, { recursive: true, force: true });

d = fixture({ "Cargo.toml": "[package]\nname='x'\n" });
check("Cargo.toml", detectCanonicalGate(d)?.cmd, "cargo test");
rmSync(d, { recursive: true, force: true });

d = fixture({ "go.mod": "module x\n" });
check("go.mod", detectCanonicalGate(d)?.cmd, "go test ./...");
rmSync(d, { recursive: true, force: true });

d = fixture({ "app.sln": "\n" });
check("*.sln", detectCanonicalGate(d)?.cmd, "dotnet test");
rmSync(d, { recursive: true, force: true });

// The case that motivated all of this: a model asked for stdlib unittest in tests/.
d = fixture({ "tests/test_thing.py": "import unittest\n", "wordfreq.py": "x=1\n" });
check("tests/test_*.py, no pytest config", detectCanonicalGate(d)?.cmd, "python -m unittest discover -s tests");
rmSync(d, { recursive: true, force: true });

// pytest must WIN over a tests/ dir when pytest is configured.
d = fixture({ "tests/test_thing.py": "x=1\n", "pytest.ini": "[pytest]\n" });
check("pytest.ini beats tests/ layout", detectCanonicalGate(d)?.cmd, "python -m pytest -q");
rmSync(d, { recursive: true, force: true });

d = fixture({ "README.md": "# nothing here\n" });
check("no test setup at all -> null", detectCanonicalGate(d), null);
rmSync(d, { recursive: true, force: true });

console.log("\ngate derivation:");
d = fixture({ "tests/test_a.py": "x=1\n" });
let g = deriveGates(d, { explicit: [], auto: true, base: null });
check("auto: derives canonical command gate", g.gates.some((x) => x.cmd === "python -m unittest discover -s tests"), true);
check("auto: no coverage gate without a base", g.gates.some((x) => x.kind === "coverage"), false);
check("auto: says UNVERIFIED when nothing found", deriveGates(fixture({ "README.md": "x" }), { auto: true }).notes.some((n) => n.includes("UNVERIFIED")), true);
g = deriveGates(d, { explicit: ["my golden gate"], auto: true, base: null });
check("explicit --gate always included", g.gates.some((x) => x.cmd === "my golden gate"), true);
g = deriveGates(d, { explicit: ["my golden gate"], auto: false, base: null });
check("--no-auto-gate keeps only explicit", g.gates.length === 1 && g.gates[0].cmd === "my golden gate", true);
rmSync(d, { recursive: true, force: true });

const bad = results.filter((r) => !r).length;
console.log(`\n${results.length - bad}/${results.length} passed`);
process.exit(bad ? 1 : 0);