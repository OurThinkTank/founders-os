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
REM Credentials load from the env file (default
REM %USERPROFILE%\.config\founders-os\foundersos-tick.env), same as the .sh
REM wrapper; override the path with FOUNDERSOS_TICK_ENV. FOUNDERSOS_TICK_BIN
REM sets how the CLI is invoked (default "founders-os-tick"; use an npx form
REM if you did not install globally).
REM ============================================================

set "ENV_FILE=%FOUNDERSOS_TICK_ENV%"
if "%ENV_FILE%"=="" set "ENV_FILE=%USERPROFILE%\.config\founders-os\foundersos-tick.env"
if exist "%ENV_FILE%" (
  for /f "usebackq eol=# tokens=1,* delims==" %%a in ("%ENV_FILE%") do set "%%a=%%~b"
)

if "%FOUNDERSOS_TICK_BIN%"=="" (set "TICK=founders-os-tick") else (set "TICK=%FOUNDERSOS_TICK_BIN%")

set "LOG_DIR=%USERPROFILE%\.local\state"
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%" 2>nul
set "LOG=%LOG_DIR%\foundersos-tick.log"

echo %date% %time% [tick-wrapper] start>> "%LOG%"

call %TICK% detect --json>> "%LOG%" 2>&1
set "RC_DETECT=%ERRORLEVEL%"

call %TICK% run --hold-only --json>> "%LOG%" 2>&1
set "RC_RUN=%ERRORLEVEL%"

echo %date% %time% [tick-wrapper] done detect=%RC_DETECT% run=%RC_RUN%>> "%LOG%"

if not "%RC_DETECT%"=="0" exit /b 1
if not "%RC_RUN%"=="0" exit /b 1
exit /b 0
