@echo off
REM ============================================================
REM Founders OS - tick wrapper (detect + run --hold-only)
REM ============================================================
REM One scheduled run = the check then the drain:
REM   1. founders-os-tick detect           fills the trigger_fires inbox
REM   2. founders-os-tick run --hold-only   stages every fire for human review
REM They run serially. Nothing is performed - staged items wait for a human.
REM Point Task Scheduler at THIS .cmd so one task does both halves.
REM
REM Set your credentials below, or rely on machine/user environment variables.
REM ============================================================

REM set "SUPABASE_URL=https://your-project.supabase.co"
REM set "SUPABASE_SECRET_KEY=sb_secret_..."

set "TICK=founders-os-tick"
set "LOG=%USERPROFILE%\foundersos-tick.log"

echo %date% %time% [tick-wrapper] start>> "%LOG%"

call %TICK% detect --json>> "%LOG%" 2>&1
set "RC_DETECT=%ERRORLEVEL%"

call %TICK% run --hold-only --json>> "%LOG%" 2>&1
set "RC_RUN=%ERRORLEVEL%"

echo %date% %time% [tick-wrapper] done detect=%RC_DETECT% run=%RC_RUN%>> "%LOG%"

if not "%RC_DETECT%"=="0" exit /b 1
if not "%RC_RUN%"=="0" exit /b 1
exit /b 0
