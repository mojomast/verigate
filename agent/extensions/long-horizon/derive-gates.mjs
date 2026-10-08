// derive-gates.mjs — harness-owned acceptance gates.
//
// Why this exists: research on agent "reward hacking" (METR RE-Bench: 30.4% of runs,
// 100% on one task family) shows a model asked to grade its own work writes a gate weak
// enough to pass its own mistakes -- an `ast.parse` check, a bare `test -f`, a hardcoded
// assertion it then quotes back as proof. Prompting it not to do that has near-zero effect.
//
// So the gates are derived HERE, in deterministic code, from facts on disk:
//   1. the project's canonical test command, discovered from its own config files
//   2. every source file the agent changed, required to be exercised by that suite
//
// The model never authors these. It may add its own per-task gate on top (plan.json
// `verify`), which is fine -- it simply is not the thing that decides whether work is done.
import { execFileSync, execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const GIT_BASH = "C:\\Program Files\\Git\\bin\\bash.exe";

function read(cwd, name) {
	try {
		return readFileSync(join(cwd, name), "utf8");
	} catch {
		return null;
	}
}

function has(cwd, name) {
	return existsSync(join(cwd, name));
}

function git(cwd, args) {
	try {
		return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return null;
	}
}

/** The single command this project already uses to decide whether it works. */
export function detectCanonicalGate(cwd) {
	// 1. Explicit build entrypoints win: they are the project's own definition of "works".
	const mk = read(cwd, "Makefile") ?? read(cwd, "makefile");
	if (mk && /^[ \t]*test[ \t]*:/m.test(mk)) return { cmd: "make test", source: "Makefile 'test' target" };

	const pkg = read(cwd, "package.json");
	if (pkg) {
		try {
			const scripts = JSON.parse(pkg).scripts ?? {};
			if (typeof scripts.test === "string") {
				const m = scripts.test.match(/^\s*([\w.-]+)/);
				const runner = { vitest: "npx vitest run", jest: "npx jest", mocha: "npx mocha" }[m?.[1]] ?? m?.[1];
				return { cmd: `${runner} test`, source: "package.json scripts.test" };
			}
		} catch {
			/* malformed package.json: fall through to other detectors */
		}
	}

	if (has(cwd, "Cargo.toml")) return { cmd: "cargo test", source: "Cargo.toml" };
	if (has(cwd, "go.mod")) return { cmd: "go test ./...", source: "go.mod" };
	if ([...readdirSync(cwd)].some((f) => f.endsWith(".sln"))) return { cmd: "dotnet test", source: "*.sln" };

	// 2. Python test runners.
	const pyproject = read(cwd, "pyproject.toml");
	if (pyproject && /\[tool\.pytest(\.ini_options)?\]/.test(pyproject)) {
		return { cmd: "python -m pytest -q", source: "pyproject.toml [tool.pytest]" };
	}
	if (has(cwd, "pytest.ini")) return { cmd: "python -m pytest -q", source: "pytest.ini" };
	const setupcfg = read(cwd, "setup.cfg");
	if (setupcfg && /\[tool:pytest\]/.test(setupcfg)) return { cmd: "python -m pytest -q", source: "setup.cfg [tool:pytest]" };

	// 3. Bare stdlib unittest layouts -- the case that motivated all of this: a model asked
	//    for "tests in tests/, stdlib unittest" would otherwise hand us a pytest file.
	for (const dir of ["tests", "test"]) {
		const full = join(cwd, dir);
		if (!existsSync(full)) continue;
		try {
			const hit = readdirSync(full).some((f) => /^test_.*\.py$/.test(f) || /^.*_test\.py$/.test(f));
			if (hit) return { cmd: `python -m unittest discover -s ${dir}`, source: `${dir}/ contains test_*.py` };
		} catch {
			/* unreadable dir: keep looking */
		}
	}
	try {
		if (readdirSync(cwd).some((f) => /^test_.*\.py$/.test(f))) {
			return { cmd: "python -m unittest discover", source: "test_*.py at repo root" };
		}
	} catch {
		/* ignore */
	}
	return null;
}

/**
 * Files the agent changed since `base` (a git sha), committed or not.
 * Untracked files matter most: a newly created module is untracked by definition, and
 * `git diff` alone would never see it -- which is exactly the file that needs testing.
 * --exclude-standard keeps .gitignore'd paths (e.g. .pi-plan) out of the result.
 */
export function changedFiles(cwd, base) {
	const out = new Set();
	if (base) {
		const diff = git(cwd, ["diff", "--name-only", base]);
		if (diff) for (const f of diff.split("\n").map((s) => s.trim()).filter(Boolean)) out.add(f);
	}
	const untracked = git(cwd, ["ls-files", "--others", "--exclude-standard"]);
	if (untracked) for (const f of untracked.split("\n").map((s) => s.trim()).filter(Boolean)) out.add(f);
	return [...out];
}

function coverageAvailable(cwd) {
	try {
		execFileSync("python", ["-c", "import coverage"], { cwd, stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

/**
 * Gate: every changed source file must be exercised by the suite.
 * This is the layer that catches a newly added, never-imported module (e.g. a cli.py whose
 * output format silently drifts from the spec while every unit test stays green).
 * Soft-fails to "unverified" when coverage.py is absent rather than pretending to pass.
 */
export function coverageGate(cwd, files, canonicalCmd) {
	const sources = files.filter((f) => /\.(py|pyi)$/.test(f));
	// Wrap the project's OWN test command under coverage rather than assuming pytest: a
	// unittest-only project must still be measurable, and that is precisely the layout a model
	// produces when asked for stdlib unittest.
	const m = /^python -m (unittest|pytest)\b(.*)$/.exec(String(canonicalCmd ?? "").trim());
	const runArgs = m ? ["-m", "coverage", "run", "-m", m[1], ...m[2].trim().split(/\s+/).filter(Boolean)] : null;
	return {
		kind: "coverage",
		source: "changed files must be exercised by the suite",
		soft: !coverageAvailable(cwd) || !runArgs,
		run() {
			if (!coverageAvailable(cwd)) {
				return { ok: true, unverified: true, out: "coverage.py not installed -- cannot verify changed files are exercised (UNVERIFIED, not passed)" };
			}
			if (!runArgs) {
				return { ok: true, unverified: true, out: `cannot measure coverage of \`${canonicalCmd}\` -- only python -m unittest/pytest can be wrapped (UNVERIFIED, not passed)` };
			}
			try {
				execFileSync("python", runArgs, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
			} catch (e) {
				return { ok: false, out: `test suite failed under coverage:\n${String(e.stdout || e.stderr || e.message).trim().split("\n").slice(-20).join("\n")}` };
			}
			const report = execFileSync("python", ["-m", "coverage", "report", "-m"], {
				cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
			});
			const seen = new Map();
			for (const line of report.split("\n")) {
				// coverage prints: "name.py   stmts   miss   cover%   missing"
				// so the percentage is the THIRD numeric column, not the first thing after the name.
				const mm = line.match(/^(\S+\.py)\s+\d+\s+\d+\s+(\d+)%/);
				if (mm) seen.set(mm[1].replace(/\\/g, "/"), Number(mm[2]));
			}
			const dead = sources.filter((f) => {
				const norm = f.replace(/\\/g, "/");
				const pct = seen.get(norm);
				return pct === undefined || pct === 0;
			});
			return {
				ok: dead.length === 0,
				out: dead.length
					? `These files you changed are not exercised by the suite at all:\n${dead.map((f) => `  ${f}`).join("\n")}\nAdd a test that imports or runs them, or delete them if they are dead.`
					: `All ${sources.length} changed Python file(s) are exercised.`,
			};
		},
	};
}

// ---------------------------------------------------------------------------
// Acceptance contract (.pi-gates.json) -- the operator's oracle, harness-owned.
//
// Research rule 6 of Expectation-Driven Development: "The implementing agent never owns
// the oracle. The code-writing agent cannot modify gold, the parity contract, scenario
// definitions, comparator, or harness acceptance logic. Oracle changes receive independent
// approval." We enforce that mechanically: the file's hash is recorded in plan.json at plan
// time, and the gate refuses to run if the agent edited it afterwards.
//
// JSON rather than YAML so the harness needs no parser dependency.
// ---------------------------------------------------------------------------
export const ORACLE_FILE = ".pi-gates.json";

export function hashOracle(cwd) {
	const p = join(cwd, ORACLE_FILE);
	if (!existsSync(p)) return null;
	try {
		return createHash("sha256").update(readFileSync(p)).digest("hex").slice(0, 16);
	} catch {
		return null;
	}
}

export function contractGate(cwd, expectedHash) {
	if (!existsSync(join(cwd, ORACLE_FILE))) return null;
	return {
		kind: "contract",
		source: `${ORACLE_FILE} (operator-owned acceptance contract)`,
		run(context = {}) {
			const now = hashOracle(cwd);
			if (expectedHash && now !== expectedHash) {
				return {
					ok: false,
					out: `The acceptance contract ${ORACLE_FILE} was MODIFIED during this run (hash ${expectedHash} -> ${now}).\n` +
						"You are not allowed to change the criteria you are judged by. Restore it with `git checkout -- ${ORACLE_FILE}` " +
						"and fix your code instead.",
				};
			}
			let spec;
			try {
				spec = JSON.parse(readFileSync(join(cwd, ORACLE_FILE), "utf8").replace(/^﻿/, ""));
			} catch (e) {
				return { ok: false, out: `${ORACLE_FILE} is not valid JSON: ${e.message}` };
			}
			const all = Array.isArray(spec.checks) ? spec.checks : [];
			if (!all.length) return { ok: false, out: `${ORACLE_FILE} declares no checks.` };
			// Per-check scoping. A check that can only pass once the WHOLE task is built (e.g. one
			// that invokes a CLI created by a later task) must not gate every individual task, or
			// the first task can never pass. `"final": true` binds it to the last task instead --
			// the same PRE/POST split as --final-gate, applied per criterion.
			const checks = context.finalTask ? all : all.filter((c) => !c.final);
			const deferred = all.length - checks.length;
			if (!checks.length) {
				return { ok: true, deferred, out: `all ${deferred} check(s) are end-of-run only (deferred to the final task)` };
			}
			const norm = (s) => String(s ?? "").replace(/\r\n/g, "\n").trimEnd();
			const failures = [];
			for (const c of checks) {
				if (!c.command) {
					failures.push(`check "${c.name ?? "?"}": no command`);
					continue;
				}
				let out = "", err = "", code = 0;
				try {
					// Same shell discipline as task gates: Git Bash on Windows, never the WSL
					// launcher that bare `bash` resolves to in system32.
					out = execSync(c.command, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...(shellForContract ? { shell: shellForContract } : {}) });
				} catch (e) {
					code = typeof e.status === "number" ? e.status : 1;
					out = String(e.stdout ?? "");
					err = String(e.stderr ?? "");
				}
				const name = c.name ?? c.command;
				if (c.expect_exit !== undefined && code !== c.expect_exit) {
					failures.push(`${name}: expected exit ${c.expect_exit}, got ${code}\n${(err || out).trim().split("\n").slice(-8).join("\n")}`);
					continue;
				}
				if (c.stdout_golden) {
					const g = join(cwd, c.stdout_golden);
					if (!existsSync(g)) {
						failures.push(`${name}: golden file ${c.stdout_golden} does not exist`);
						continue;
					}
					const want = norm(readFileSync(g, "utf8"));
					if (norm(out) !== want) {
						failures.push(`${name}: output does not match ${c.stdout_golden}\n--- expected ---\n${want}\n--- actual ---\n${norm(out)}`);
						continue;
					}
				}
				if (c.stdout_regex && !new RegExp(c.stdout_regex, "m").test(out)) {
					failures.push(`${name}: stdout did not match /${c.stdout_regex}/\n--- actual ---\n${norm(out).slice(0, 400)}`);
					continue;
				}
				if (c.stdout_not_regex && new RegExp(c.stdout_not_regex, "m").test(out)) {
					failures.push(`${name}: stdout matched forbidden /${c.stdout_not_regex}/`);
					continue;
				}
				if (c.stdout_empty && norm(out) !== "") {
					failures.push(`${name}: expected empty stdout, got:\n${norm(out).slice(0, 300)}`);
					continue;
				}
				if (c.stderr_empty && err.trim()) {
					failures.push(`${name}: expected empty stderr, got:\n${err.trim().split("\n").slice(-5).join("\n")}`);
					continue;
				}
				if (c.max_stdout_lines !== undefined && out.trimEnd().split("\n").length > c.max_stdout_lines) {
					failures.push(`${name}: stdout has more than ${c.max_stdout_lines} lines`);
					continue;
				}
			}
			return {
				ok: failures.length === 0,
				deferred,
				out: failures.length
					? `${failures.length}/${checks.length} acceptance check(s) failed${deferred ? ` (${deferred} end-of-run check(s) deferred)` : ""}:\n${failures.map((f) => `  - ${f}`).join("\n")}`
					: `all ${checks.length} acceptance check(s) passed${deferred ? ` (${deferred} end-of-run check(s) deferred)` : ""}`,
			};
		},
	};
}

// Contract checks are shell commands (golden-file diffs, pipes), so they run under Git Bash
// on Windows for the same reason task gates do.
const GIT_BASH_EXE = "C:\\Program Files\\Git\\bin\\bash.exe";
const shellForContract = process.platform === "win32" && existsSync(GIT_BASH_EXE) ? GIT_BASH_EXE : undefined;

// ---------------------------------------------------------------------------
// Planted-mutation floor: the only layer that measures whether assertions constrain
// behaviour rather than merely execute. Coverage cannot do this -- an assertion-free test
// reaches 100%. We plant a small fixed operator set in the files the agent changed and
// require the suite to notice. Deliberately bounded (few operators, capped count) because
// full mutation testing costs mutants x suite-runtime and mutmut cannot parallelise.
// ---------------------------------------------------------------------------
const MUTATION_OPERATORS = [
	{ find: "==", replace: "!=", label: "== -> !=" },
	{ find: ">=", replace: ">", label: ">= -> >" },
	{ find: "<=", replace: "<", label: "<= -> <" },
	{ find: " + ", replace: " - ", label: "+ -> -" },
];

export function mutationGate(cwd, files, { min = 60, max = 12, testCmd } = {}) {
	const sources = files.filter((f) => /\.py$/.test(f));
	const m = /^python -m (unittest|pytest)\b(.*)$/.exec(String(testCmd ?? "").trim());
	if (!sources.length || !m) return null;
	const argv = ["-m", m[1], ...m[2].trim().split(/\s+/).filter(Boolean)];

	const mutants = [];
	for (const f of sources) {
		const abs = join(cwd, f);
		if (!existsSync(abs)) continue;
		const original = readFileSync(abs, "utf8");
		for (const op of MUTATION_OPERATORS) {
			if (mutants.length >= max) break;
			const idx = original.indexOf(op.find);
			if (idx === -1) continue;
			const line = original.slice(0, idx).split("\n").length;
			mutants.push({ file: abs, rel: f, line, op, original, mutated: original.slice(0, idx) + op.replace + original.slice(idx + op.find.length) });
		}
	}
	if (!mutants.length) return null;

	return {
		kind: "mutation",
		source: `planted mutations in changed files (floor ${min}%)`,
		run() {
			const results = [];
			for (const mu of mutants) {
				writeFileSync(mu.file, mu.mutated, "utf8");
				try {
					execFileSync("python", argv, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
					results.push({ ...mu, killed: false }); // suite still green -> assertions did not notice
				} catch {
					results.push({ ...mu, killed: true });
				} finally {
					writeFileSync(mu.file, mu.original, "utf8"); // always restore
				}
			}
			const killed = results.filter((r) => r.killed).length;
			const pct = Math.round((killed / results.length) * 100);
			const survived = results.filter((r) => !r.killed);
			return {
				ok: pct >= min,
				out: `mutation score ${pct}% (${killed}/${results.length} killed, floor ${min}%)\n` +
					(survived.length
						? `Survived -- your tests do not notice these breaks:\n${survived.map((r) => `  ${r.rel}:${r.line}  ${r.op.label}`).join("\n")}\nEach survivor is a test that executes the line without constraining it.`
						: `All ${results.length} planted mutations were caught.`),
			};
		},
	};
}
// ---------------------------------------------------------------------------
// Static oracle check: "test theater".
//
// Empirical base rate (arXiv 2606.18168: 86,156 agent-authored test patches across 2,807 repos):
// 80.2% of agent-written test files contain weak or NO explicit oracle signals, and strong-oracle
// rates on newly created files run from 18% to 67% depending on the agent. Test-file presence
// badly overestimates verification strength, so a cheap static screen earns its keep alongside
// the (dynamic, slower) mutation gate.
// ---------------------------------------------------------------------------
const TEST_BASENAME = /(^test_.*\.py$|.*_test\.py$|.*\.test\.[cm]?[jt]sx?$|.*\.spec\.[cm]?[jt]sx?$|.*Test\.[cm]?[jt]sx?$)/;
const TEST_DECL = /(^|\n)\s*(def test_|async def test_|it\(|test\(|func Test)/;
const ASSERTION_PATTERNS = [
	/\bassert\b/, /\bassertEqual\b/, /\bassert[A-Z]\w*\s*\(/, /\bself\.assert/, /\bexpect\s*\(/,
	/\braises\b/, /\bassertRaises\b/, /\bassertions\b/, /\bfail\s*\(/, /\bmust_throw\b/,
	/\btoEqual\b/, /\btoBe\b/, /\btoThrow\b/, /\bassert_match\b/,
];

export function isTestFile(rel) {
	const base = rel.split("/").pop() ?? rel;
	return TEST_BASENAME.test(base) || /(^|\/)(tests?|__tests__)\//.test(rel);
}

export function assertionGate(cwd, files) {
	const tests = files.filter(isTestFile);
	if (!tests.length) return null;
	const hollow = [];
	for (const f of tests) {
		const abs = join(cwd, f);
		if (!existsSync(abs)) continue;
		const src = readFileSync(abs, "utf8");
		if (!TEST_DECL.test(src)) continue; // helper or fixture, not a test file
		if (!ASSERTION_PATTERNS.some((p) => p.test(src))) hollow.push(f);
	}
	if (!hollow.length) return null;
	return {
		kind: "assertions",
		derivation_source: "repo",
		source: "changed test files must contain explicit assertions",
		run() {
			return {
				ok: false,
				out:
					`These test files you added contain NO assertion of any kind:\n${hollow.map((f) => `  ${f}`).join("\n")}\n` +
					"They execute code but never check a result, so they pass no matter what the code does.\n" +
					"Add assertions that compare against independently-derived expected values.",
			};
		},
	};
}

/**
 * Build the harness gate set. Explicit --gate commands always win and are always included;
 * auto-derived gates are additive and can be suppressed with --no-auto-gate.
 *
 * Every gate carries `derivation_source` (Blind Oracle): "operator" means the expected value
 * came from a channel the agent cannot influence; "repo" means it was derived from files the
 * agent itself created, and is therefore anchored on the draft and structurally weaker.
 */
export function deriveGates(cwd, { explicit = [], final = [], auto = true, base = null, oracleHash = null, mutation = null } = {}) {
	const gates = [];
	const notes = [];
	for (const cmd of explicit) gates.push({ kind: "command", cmd, source: "operator --gate", derivation_source: "operator" });
	for (const cmd of final) gates.push({ kind: "command", cmd, source: "operator --final-gate", final: true, derivation_source: "operator" });

	if (!auto) return { gates, notes: ["auto-derivation disabled (--no-auto-gate)"] };

	const canonical = detectCanonicalGate(cwd);
	if (canonical) {
		gates.push({ kind: "command", cmd: canonical.cmd, source: `auto: ${canonical.source}`, derivation_source: "repo" });
		notes.push(`auto gate [repo-derived]: ${canonical.cmd}  (from ${canonical.source})`);
	} else {
		notes.push("UNVERIFIED: no canonical test command found (no Makefile test target, package.json scripts.test, pytest config, Cargo.toml, go.mod, *.sln, or tests/test_*.py). Nothing can be auto-verified.");
	}

	const contract = contractGate(cwd, oracleHash);
	if (contract) {
		gates.push({ ...contract, derivation_source: "operator" });
		notes.push(`auto gate [operator]: acceptance contract ${ORACLE_FILE} (hash ${hashOracle(cwd)}, agent edits are rejected)`);
	}

	const changed = changedFiles(cwd, base);
	const py = changed.filter((f) => /\.pyi?$/.test(f));
	if (py.length) {
		gates.push({ ...coverageGate(cwd, py, canonical?.cmd), derivation_source: "repo" });
		notes.push(`auto gate [repo-derived]: every changed Python file must be exercised (${py.length} file(s) changed: ${py.join(", ")})`);

		const ag = assertionGate(cwd, changed);
		if (ag) {
			gates.push(ag);
			notes.push(`auto gate [repo-derived]: changed test files must contain explicit assertions (${changed.filter(isTestFile).join(", ")})`);
		}

		if (mutation) {
			const mg = mutationGate(cwd, py, { min: mutation.min ?? 60, max: mutation.max ?? 12, testCmd: canonical?.cmd });
			if (mg) {
				gates.push({ ...mg, derivation_source: "repo" });
				notes.push(`auto gate [repo-derived]: planted mutations in changed files must be caught (floor ${mutation.min ?? 60}%)`);
			} else {
				notes.push("mutation gate skipped: no planted operators applicable, or test command is not python -m unittest/pytest");
			}
		}
	}
	return { gates, notes };
}

export const _internals = { git, GIT_BASH };