@echo off
setlocal EnableExtensions DisableDelayedExpansion
cd /d "%~dp0"

if not exist "node_modules\.bin\tsx.cmd" goto :missing_dependencies
if not exist "node_modules\electron\dist\electron.exe" goto :missing_dependencies
if not exist "dist-electron\electron\main.js" goto :missing_build
if not exist "dist-renderer\index.html" goto :missing_build
if /i "%~1"=="--self-test" goto :self_test

:menu
cls
echo ============================================================
echo Geumcheon AI Typing King - Round 1 UI Review
echo ============================================================
echo Synthetic credential and local Mock NAS only.
echo Production NAS and production secrets are never used.
echo.
echo 1. AI Typing King
echo 2. AI Leaderboard
echo 3. Practice AI Typing King
echo 4. Practice AI Leaderboard
echo 0. Exit
echo.
set "review_choice="
set "review_variant="
set /p "review_choice=Select 0-4: "
if "%review_choice%"=="0" exit /b 0
if "%review_choice%"=="1" set "review_variant=ai"
if "%review_choice%"=="2" set "review_variant=ai-leaderboard"
if "%review_choice%"=="3" set "review_variant=practice"
if "%review_choice%"=="4" set "review_variant=practice-leaderboard"
if not defined review_variant goto :invalid_choice

echo.
echo Close the game window when the review is finished.
call "node_modules\.bin\tsx.cmd" "scripts\e2e-geumcheon-approved-ui-check.ts" --interactive --variant=%review_variant%
set "review_exit=%ERRORLEVEL%"
if not "%review_exit%"=="0" goto :review_failed
echo.
echo Review session closed and temporary test data was removed.
pause
goto :menu

:invalid_choice
echo.
echo [ERROR] Select a number from 0 to 4.
pause
goto :menu

:review_failed
echo.
echo [ERROR] Review launcher failed. Exit code: %review_exit%
echo See test_artifacts\geumcheon_approved_ui for diagnostics.
pause
exit /b %review_exit%

:missing_dependencies
echo.
echo [ERROR] Required local dependencies are missing.
echo Run npm ci, then try again. Production NAS credentials are not required.
pause
exit /b 1

:missing_build
echo.
echo [ERROR] The current game build is missing.
echo Run npm run build, then try again. Production NAS credentials are not required.
pause
exit /b 1

:self_test
echo ROUND1_REVIEW_LAUNCHER_SELF_TEST=PASS
exit /b 0
