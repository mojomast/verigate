@echo off
rem Windows launcher for the long-horizon driver.
rem NOTE: deliberately no SETLOCAL - see pi-ornith.cmd.
rem Usage (from your project dir): pi-plan.cmd --goal "..."   |   pi-plan.cmd  (resume)
set "PI_CODING_AGENT_DIR=%~dp0agent"
node "%~dp0agent\extensions\long-horizon\run-plan.mjs" %*
