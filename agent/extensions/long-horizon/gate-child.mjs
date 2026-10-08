// Stand-in for the Pi subprocess, used only by gate-handoff.test.mjs.
//
// In production the long-horizon extension (index.ts) calls armGatesForPlan() inside its
// task_done handler -- in the process that actually decides whether a task passed. This script
// does the same thing from a separate process, so the test can prove the gate options survive the
// driver -> Pi process boundary. If arming only happened in the driver, this script would arm
// nothing and every gate would silently pass.
import { armGatesForPlan, completeTask, loadPlan } from "./plan-lib.mjs";

const cwd = process.argv[2];
const id = Number(process.argv[3] ?? 1);

const { gates } = armGatesForPlan(cwd);
console.log("ARMED:", gates.map((g) => g.cmd ?? `[${g.kind}]`).join(" | "));

const r = completeTask(cwd, id, "");
console.log("OK:", r.ok);
console.log("STATUS:", loadPlan(cwd).tasks.find((t) => t.id === id).status);
console.log("MSG-START");
console.log(r.message);
console.log("MSG-END");