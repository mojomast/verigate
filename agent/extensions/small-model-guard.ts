/**
 * small-model-guard: harness-side guardrails for small (7-9B) local models.
 *
 * 1. tool_result: cap output to a small budget (head+tail), spill the full text to a temp
 *    file, tell the model how to read the rest. Pi's built-in cap is 2000 lines / 50KB,
 *    which is far too large for a 32k window.
 * 2. tool_result: give empty results an explicit message, so "no output" is not read as failure.
 * 3. tool_result: after edit/write, run a cheap syntax check and append the error (SWE-agent style).
 * 4. tool_call: circuit breaker. Block an identical call that already failed twice, or the same
 *    call made 3 times in a row (loop detection), and tell the model to change approach.
 *
 * Tune the constants below to your context size.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, isAbsolute, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MAX_LINES = 120; // lines kept per tool result
const MAX_CHARS = 6000; // ~1.5k tokens
const TAIL_SHARE = 0.6; // fraction of the budget kept from the end (errors/test summaries live there)
const TAIL_FIRST_TOOLS = new Set(["bash"]); // for these, the tail is more valuable than the head
const MAX_SAME_FAILURES = 2;
const MAX_IDENTICAL_STREAK = 3;

// Windows: `python3` resolves to the Microsoft Store alias stub, which exits non-zero with a
// store message instead of ENOENT -- that would be reported as a bogus syntax error. `bash` on
// PATH is the WSL launcher in system32, which checks files in a different filesystem root.
const IS_WIN = process.platform === "win32";
const GIT_BASH = "C:\\Program Files\\Git\\bin\\bash.exe";
const PY = IS_WIN ? "python" : "python3";
const SH = IS_WIN ? GIT_BASH : "bash";

const sig = (name: string, input: unknown) => `${name}:${JSON.stringify(input)}`;

function clip(text: string, tailFirst: boolean): { text: string; clipped: boolean; total: number } {
	const lines = text.split("\n");
	if (lines.length <= MAX_LINES && text.length <= MAX_CHARS) return { text, clipped: false, total: lines.length };
	const tailShare = tailFirst ? TAIL_SHARE : 0.25;
	let headN = Math.max(1, Math.floor(MAX_LINES * (1 - tailShare)));
	let tailN = Math.max(1, MAX_LINES - headN);
	let head = lines.slice(0, headN);
	let tail = lines.slice(-tailN);
	// enforce char budget too
	const budget = (s: string[], max: number) => {
		let out = s.join("\n");
		return out.length > max ? out.slice(0, max) : out;
	};
	if (lines.length <= MAX_LINES) {
		// few but very long lines
		const h = text.slice(0, Math.floor(MAX_CHARS * (1 - tailShare)));
		const t = text.slice(-Math.floor(MAX_CHARS * tailShare));
		return { text: `${h}\n[... middle of long lines omitted ...]\n${t}`, clipped: true, total: lines.length };
	}
	const h = budget(head, Math.floor(MAX_CHARS * (1 - tailShare)));
	const t = budget(tail.reverse(), Math.floor(MAX_CHARS * tailShare)).split("\n").reverse().join("\n");
	const omitted = lines.length - head.length - tail.length;
	return { text: `${h}\n[... ${omitted} lines omitted ...]\n${t}`, clipped: true, total: lines.length };
}

function syntaxCheck(file: string, cwd: string): string | undefined {
	const path = isAbsolute(file) ? file : resolve(cwd, file);
	const run = (cmd: string, args: string[]) => {
		try {
			execFileSync(cmd, args, { stdio: "pipe", timeout: 10_000, cwd });
			return undefined;
		} catch (e: any) {
			if (e.code === "ENOENT") return undefined; // checker not installed: skip silently
			return String(e.stderr || e.stdout || e.message).trim().split("\n").slice(0, 8).join("\n");
		}
	};
	switch (extname(path)) {
		case ".py":
			return run(PY, ["-m", "py_compile", path]);
		case ".js":
		case ".mjs":
		case ".cjs":
			return run("node", ["--check", path]);
		case ".rb":
			return run("ruby", ["-c", path]);
		case ".sh":
		case ".bash":
			return run(SH, ["-n", path]);
		case ".json":
			return run(PY, ["-c", "import json,sys;json.load(open(sys.argv[1]))", path]);
		default:
			return undefined;
	}
}

export default function (pi: ExtensionAPI) {
	const calls = new Map<string, string>(); // toolCallId -> signature
	const failures = new Map<string, number>(); // signature -> failed count
	let last: { s: string; n: number } = { s: "", n: 0 };

	pi.on("session_start", () => {
		calls.clear();
		failures.clear();
		last = { s: "", n: 0 };
	});

	pi.on("tool_call", async (event) => {
		const s = sig(event.toolName, event.input);
		calls.set(event.toolCallId, s);
		last = last.s === s ? { s, n: last.n + 1 } : { s, n: 1 };
		if ((failures.get(s) ?? 0) >= MAX_SAME_FAILURES) {
			return {
				block: true,
				reason: `This exact ${event.toolName} call already failed ${MAX_SAME_FAILURES} times. Do not repeat it. Re-read the error, then try a different approach or explain what is blocking you.`,
			};
		}
		if (last.n >= MAX_IDENTICAL_STREAK) {
			return {
				block: true,
				reason: `You made the same ${event.toolName} call ${last.n} times in a row with no progress. Do something different, or give your final answer.`,
			};
		}
		return undefined;
	});

	pi.on("tool_result", async (event, ctx) => {
		const s = calls.get(event.toolCallId) ?? "";
		if (event.isError) failures.set(s, (failures.get(s) ?? 0) + 1);

		const parts = (event.content ?? []) as Array<{ type: string; text?: string }>;
		const text = parts.filter((p) => p.type === "text").map((p) => p.text ?? "").join("\n");
		const others = parts.filter((p) => p.type !== "text");
		let out = text;

		if (!out.trim() && !event.isError && others.length === 0) {
			out = "(ok: the command ran successfully and produced no output)";
		}

		const { text: clipped, clipped: wasClipped } = clip(out, TAIL_FIRST_TOOLS.has(event.toolName));
		out = clipped;
		if (wasClipped) {
			const dir = mkdtempSync(join(tmpdir(), "pi-spill-"));
			const file = join(dir, "full-output.txt");
			writeFileSync(file, text, "utf8");
			out += `\n[Output truncated to save context. Full text: ${file}. Use read with offset/limit or grep on that file for specifics.]`;
		}

		let isErr = event.isError;
		if ((event.toolName === "edit" || event.toolName === "write") && !event.isError) {
			const input = event.input as { path?: string; file_path?: string };
			const file = input?.path ?? input?.file_path;
			const err = file ? syntaxCheck(file, ctx.cwd) : undefined;
			if (err) {
				out += `\n[SYNTAX ERROR after your change in ${file}:\n${err}\nFix this before continuing.]`;
				isErr = true;
				if (s) failures.set(s, (failures.get(s) ?? 0) + 1);
			}
		}

		if (out === text && isErr === event.isError && others.length === 0) return undefined;
		return { content: [{ type: "text" as const, text: out }, ...others], isError: isErr };
	});
}
