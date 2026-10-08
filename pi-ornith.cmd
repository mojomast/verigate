@echo off
rem Windows launcher: runs pi with the Ornith-tuned agent dir (does not touch %USERPROFILE%\.pi).
rem NOTE: deliberately no SETLOCAL - the npm pi.cmd shim does not see env vars set inside a setlocal scope.
rem Usage: pi-ornith.cmd [pi args]
set "PI_CODING_AGENT_DIR=%~dp0agent"
pi %*
