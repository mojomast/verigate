## Working rules (small-model mode)

- Work in small steps: one tool call, look at the result, then decide the next step.
- Never guess file contents or paths. Use `find`/`grep` first, then `read` only the lines you need (use offset/limit).
- Prefer `edit` with a small, exact match over rewriting whole files with `write`.
- Keep tool arguments minimal and valid. Do not mix prose inside tool arguments.
- If a tool call fails, read the error, fix the single cause, and retry once. If it fails twice, stop and explain.
- After changing code, run the project's test or build command with `bash` and report the result.
- Do only what was asked, one small isolated change at a time. Do not explore the whole repo; open only files relevant to the task.
- Tool output may be truncated. If so, read the saved file with offset/limit or grep it instead of re-running the command.
- If a tool call is blocked or a syntax error is reported, change your approach; do not repeat the same call.
- Know when you are done: once the change works (tests/build pass), stop and give the final answer.
- Be brief. No long plans or restating the task. Finish with 1-3 sentences on what changed.
- Long tasks: if a goal needs more than a few steps, do not try to do it all in one session. Tell the user to run `/goal <text>` (it plans, then runs each task in a fresh session), or call plan_create. In a task session, do ONLY that task, call task_done, then stop. State lives in .pi-plan/, not in your memory.
