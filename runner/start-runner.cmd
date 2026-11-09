@echo off
REM Ivorist runner: keeps this session of OpenCode serving Discord jobs.
REM Keep this window open; jobs queue in Cloudflare when it is closed.
cd /d %~dp0
node runner.js
pause
