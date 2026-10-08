/**
 * long-horizon: durable multi-task work, driven entirely from inside the Pi TUI.
 *
 *   /goal <text>   plan (fresh session) -> you confirm -> run every task, each in a FRESH session
 *   /run           resume the saved plan
 *   /tasks         show checklist
 *   /stop          stop after the current turn
 *
 * Model-facing tools (tiny, flat schemas): plan_create, task_done, task_blocked, plan_status.
 * Real logic (state, verification gate, commits) is in plan-lib.mjs, shared with the headless driver run-plan.mjs.
 * A checklist widget and a footer status stay visible in the TUI while it works.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
// @ts-ignore plain JS module shared with the driver
import { armGatesForPlan, blockTask, buildTaskPrompt, completeTask, createPlan, hasBlocked, hasIncomplete, hasPlan, isFinished, loadPlan, nextTask, noteRunEnded, PLANNING_PROMPT, progressTail, resetPlan, summary, unblockTask } from "./plan-lib.mjs";

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

// Schema-level phase scoping: during a planning session the task tools are not merely
// discouraged, they are NOT REGISTERED. The model cannot call task_done to mark work finished
// because the tool does not exist in its schema. A prompt instruction ("plan only, do not
// implement") was demonstrably bypassed in testing; this makes the bypass impossible.
const PHASE = (process.env.PI_PHASE ?? "execute").toLowerCase();
const IS_PLANNING = PHASE === "plan";

export default function (pi: ExtensionAPI) {
	let stopRequested = false;
	let running = false;
	let aborted = false;
	let waiters: Array<() => void> = [];

	// ---- TUI helpers ------------------------------------------------------------------------
	const render = (ctx: any, current?: { id: number; title: string }) => {
		try {
			if (!hasPlan(ctx.cwd)) {
				ctx.ui.setStatus("plan", undefined);
				ctx.ui.setWidget("plan", undefined);
				return;
			}
			const plan = loadPlan(ctx.cwd);
			const done = plan.tasks.filter((t: any) => t.status === "done").length;
			ctx.ui.setStatus("plan", current ? `▶ task ${current.id}/${plan.tasks.length}: ${current.title}` : `plan ${done}/${plan.tasks.length}`);
			ctx.ui.setWidget("plan", [`Goal: ${plan.goal}`, ...summary(plan).split("\n")]);
		} catch {
			/* UI not available (print mode): ignore */
		}
	};

	// Resolve when Pi has fully settled a prompt (retries, compaction etc. included).
	pi.on("agent_settled", async (event: any) => {
		if (event?.aborted) aborted = true;
		const w = waiters;
		waiters = [];
		w.forEach((f) => f());
	});
	const settled = () => new Promise<void>((r) => waiters.push(r));
	const runPrompt = async (c: any, prompt: string) => {
		aborted = false;
		const done = settled(); // register before sending so we cannot miss the signal
		await c.sendUserMessage(prompt);
		await done;
	};

	pi.on("session_start", async (_e: any, ctx: any) => render(ctx));

	// ---- the loop: one FRESH session per task ------------------------------------------------
	const finish = (c: any) => {
		running = false;
		render(c);
		if (!hasPlan(c.cwd)) return;
		const plan = loadPlan(c.cwd);
		if (isFinished(plan)) c.ui.notify("All tasks done. See .pi-plan/progress.md and git log.", "info");
		else if (hasBlocked(plan)) c.ui.notify("Stopped: a task is blocked. Fix it (or edit .pi-plan/plan.json), then /run.", "warning");
		else c.ui.notify("Stopped. /run resumes.", "info");
	};

	const step = async (c: any): Promise<void> => {
		if (!hasPlan(c.cwd)) return finish(c);
		const plan = loadPlan(c.cwd);
		const task = nextTask(plan);
		if (!task || stopRequested || hasBlocked(plan)) return finish(c);
		const before = task.attempts;
		const prompt = buildTaskPrompt(c.cwd, plan, task);
		const r = await c.newSession({
			withSession: async (c2: any) => {
				render(c2, task);
				c2.ui.notify(`Task ${task.id}/${plan.tasks.length}: ${task.title}`, "info");
				await runPrompt(c2, prompt);
				noteRunEnded(c2.cwd, task.id, before);
				if (aborted) stopRequested = true;
				render(c2);
				await step(c2); // next task, new session (recursion depth <= number of tasks)
			},
		});
		if (r?.cancelled) {
			running = false;
			c.ui.notify("New session was cancelled; stopping.", "warning");
		}
	};

	const start = async (c: any) => {
		if (running) return c.ui.notify("Already running. /stop to stop.", "warning");
		running = true;
		stopRequested = false;
		await step(c);
	};

	// ---- slash commands ----------------------------------------------------------------------
	pi.registerCommand("goal", {
		description: "Plan a large goal into small verified tasks, then run them one per fresh session",
		handler: async (args: string, ctx: any) => {
			await ctx.waitForIdle();
			let goal = (args || "").trim();
			if (!goal) goal = (await ctx.ui.input("Goal", "What should be built or changed?")) ?? "";
			if (!goal.trim()) return;
			if (hasPlan(ctx.cwd) && !isFinished(loadPlan(ctx.cwd))) {
				const ok = await ctx.ui.confirm("Unfinished plan exists", `${summary(loadPlan(ctx.cwd))}\n\nReplace it?`);
				if (!ok) return;
			}
			resetPlan(ctx.cwd);
			await ctx.newSession({
				withSession: async (c: any) => {
					c.ui.setStatus("plan", "planning...");
					await runPrompt(c, PLANNING_PROMPT(goal));
					if (!hasPlan(c.cwd)) {
						c.ui.setStatus("plan", undefined);
						return c.ui.notify("The model did not produce a plan. Try /goal again with a more specific goal.", "error");
					}
					render(c);
					const go = await c.ui.confirm("Run this plan?", `${loadPlan(c.cwd).goal}\n\n${summary(loadPlan(c.cwd))}\n\nEach task runs in a fresh session. /stop interrupts.`);
					if (go) await start(c);
					else c.ui.notify("Plan saved. Edit .pi-plan/plan.json if you like, then /run.", "info");
				},
			});
		},
	});

	pi.registerCommand("run", {
		description: "Resume the saved plan (one fresh session per remaining task)",
		handler: async (_args: string, ctx: any) => {
			await ctx.waitForIdle();
			if (!hasPlan(ctx.cwd)) return ctx.ui.notify("No plan. Use /goal <text>.", "warning");
			await start(ctx);
		},
	});

	pi.registerCommand("tasks", {
		description: "Show the plan checklist and recent progress",
		handler: async (_args: string, ctx: any) => {
			render(ctx);
			ctx.ui.notify(hasPlan(ctx.cwd) ? `${loadPlan(ctx.cwd).goal}\n${summary(loadPlan(ctx.cwd))}\n\n${progressTail(ctx.cwd, 6)}` : "No plan yet. /goal <text>", "info");
		},
	});

	pi.registerCommand("stop", {
		description: "Stop the long-horizon loop after the current turn",
		handler: async (_args: string, ctx: any) => {
			stopRequested = true;
			ctx.abort();
			ctx.ui.notify("Stopping. /run resumes.", "info");
		},
	});

	// ---- model-facing tools ------------------------------------------------------------------
	// Planning sessions get plan_create only. task_done / task_blocked / plan_status are how an
	// agent declares progress, and a planner that can call them can finish the entire job before
	// the execution loop ever starts -- which is exactly what happened in testing.
	if (IS_PLANNING) {
		pi.registerTool({
			name: "plan_create",
			label: "plan",
			description:
				"Create the task plan for a large goal. Give 3-8 SMALL ordered tasks. Each task needs a title and, whenever possible, a `verify` shell command that exits 0 only when it is truly done (tests, build, grep, file exists).",
			promptSnippet: "Create a verified task plan for a multi-step goal",
			promptGuidelines: ["Call plan_create ONCE when given a multi-step goal, then stop."],
			parameters: Type.Object({
				goal: Type.String({ description: "One-sentence overall goal" }),
				tasks: Type.Array(
					Type.Object({
						title: Type.String({ description: "Small, concrete, single-purpose task" }),
						verify: Type.Optional(Type.String({ description: "Shell command that exits 0 when the task is done" })),
					}),
				),
			}),
			async execute(_id, params, _signal, _onUpdate, ctx) {
				const plan = createPlan(ctx.cwd, params.goal, params.tasks);
				render(ctx);
				return text(`Plan saved with ${plan.tasks.length} tasks:\n${summary(plan)}\nStop now; execution starts task by task.`);
			},
		});
		return;
	}

	pi.registerTool({
		name: "plan_create",
		label: "plan",
		description:
			"Create the task plan for a large goal. Give 3-8 SMALL ordered tasks. Each task needs a title and, whenever possible, a `verify` shell command that exits 0 only when the task is truly done (tests, build, grep, file exists).",
		promptSnippet: "Create a verified task plan for a multi-step goal",
		promptGuidelines: ["Call plan_create ONCE when given a multi-step goal, then stop."],
		parameters: Type.Object({
			goal: Type.String({ description: "One-sentence overall goal" }),
			tasks: Type.Array(
				Type.Object({
					title: Type.String({ description: "Small, concrete, single-purpose task" }),
					verify: Type.Optional(Type.String({ description: "Shell command that exits 0 when the task is done" })),
				}),
			),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const plan = createPlan(ctx.cwd, params.goal, params.tasks);
			render(ctx);
			return text(`Plan saved with ${plan.tasks.length} tasks:\n${summary(plan)}\nStop now; execution starts task by task.`);
		},
	});

	pi.registerTool({
		name: "task_requeue",
		label: "requeue task",
		description:
			"Move a task that was parked as UNSATISFIABLE back to pending. Use only when the gate that blocked it should now pass -- e.g. after the files it needs have been created by another task.",
		promptSnippet: "Requeue a task parked as unsatisfiable",
		promptGuidelines: ["Use task_requeue instead of retrying task_done on an unsatisfiable task."],
		parameters: Type.Object({
			task_id: Type.Number(),
			reason: Type.Optional(Type.String({ description: "Why it can pass now" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const plan = unblockTask(ctx.cwd, params.task_id, params.reason ?? "");
			render(ctx, nextTask(plan) ?? undefined);
			return text(`Task ${params.task_id} requeued to pending.`);
		},
	});

	pi.registerTool({
		name: "task_done",
		label: "task done",
		description: "Mark your current task finished. The harness runs the task's check command; if it fails you get the error and must fix it.",
		promptSnippet: "Mark the current task finished and trigger verification",
		promptGuidelines: ["Call task_done only after making the changes and testing them."],
		parameters: Type.Object({
			task_id: Type.Number({ description: "Id of your current task" }),
			note: Type.Optional(Type.String({ description: "One line: what you did, anything the next task must know" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			// Arm the harness gates IN THIS PROCESS before deciding. The driver derives them, but
			// this tool runs in the Pi subprocess; without this the harness is silently ungated
			// and only the model's own (weak) task verify applies.
			armGatesForPlan(ctx.cwd);
			const r = completeTask(ctx.cwd, params.task_id, params.note ?? "");
			render(ctx, nextTask(r.plan) ?? undefined);
			if (!r.ok) throw new Error(r.message); // thrown => isError, so the circuit breaker also counts it
			return text(r.message);
		},
	});

	pi.registerTool({
		name: "task_blocked",
		label: "task blocked",
		description: "Report that your current task cannot be completed, with the reason. Use after a real attempt, not instead of one.",
		promptSnippet: "Report that the current task is blocked",
		parameters: Type.Object({ task_id: Type.Number(), reason: Type.String() }),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			blockTask(ctx.cwd, params.task_id, params.reason);
			render(ctx);
			return text(`Task ${params.task_id} marked blocked. Stop now.`);
		},
	});

	pi.registerTool({
		name: "plan_status",
		label: "plan status",
		description: "Show the plan checklist.",
		promptSnippet: "Show the current plan checklist and task progress",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			return text(hasPlan(ctx.cwd) ? `${loadPlan(ctx.cwd).goal}\n${summary(loadPlan(ctx.cwd))}` : "No plan yet.");
		},
	});
}
