@echo off
title DigiQuiz Dev
cd /d "%~dp0"

REM ============================================================================
REM  DigiQuiz - double-clickable launcher
REM
REM  Double-click this file in File Explorer. No typing required.
REM
REM  It runs start.ps1 with -NoProfile -ExecutionPolicy Bypass so that Windows
REM  script-blocking and any slow PowerShell profile are both out of the way,
REM  and it ALWAYS ends in `pause` so the window stays open and readable in a
REM  screenshot - whether it worked or not.
REM ============================================================================

echo.
echo   ================================================================
echo                        D I G I Q U I Z   D E V
echo   ================================================================
echo.
echo   Folder : %CD%
echo   Started: %DATE% %TIME%
echo.
echo   Watch for the white URL bar below - that is the address to open
echo   on your phone. It is printed near the top and again at the end.
echo.

REM --- Is PowerShell even available? -----------------------------------------
where powershell >nul 2>&1
if errorlevel 1 (
    echo   ############################################################
    echo.
    echo    POWERSHELL MISSING: could not find powershell.exe on PATH
    echo.
    echo   ############################################################
    echo.
    echo   This is very unusual on Windows. Try running start.ps1 by
    echo   right-clicking it and choosing "Run with PowerShell".
    echo.
    goto :end
)

REM --- Is start.ps1 actually next to this file? ------------------------------
if not exist "%~dp0start.ps1" (
    echo   ############################################################
    echo.
    echo    MISSING FILE: start.ps1 was not found next to this launcher
    echo.
    echo   ############################################################
    echo.
    echo   Expected: %~dp0start.ps1
    echo.
    echo   Keep START-DIGIQUIZ.bat inside the digiquiz-dev folder -
    echo   do not copy it to the Desktop on its own.
    echo.
    goto :end
)

REM --- Run it ----------------------------------------------------------------
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
set "RC=%ERRORLEVEL%"

echo.
echo   ----------------------------------------------------------------
echo   start.ps1 finished with exit code %RC%
echo   ----------------------------------------------------------------
echo.

if "%RC%"=="0" (
    echo   Stopped normally. If you pressed Ctrl+C, the servers are shut down.
    echo   Double-click this file again to restart.
    goto :end
)

if "%RC%"=="3" (
    echo   ############################################################
    echo.
    echo    NODE PREFLIGHT FAILED
    echo.
    echo   ############################################################
    echo.
    echo   Scroll up - there is one red line saying exactly what is wrong,
    echo   for example:
    echo.
    echo       NODE TOO OLD: found v18.16.0, need v22.5.0+
    echo.
    echo   If you have nvm installed, the fix is:
    echo.
    echo       nvm install 22
    echo       nvm use 22
    echo.
    echo   then double-click this file again.
    goto :end
)

echo   Something went wrong. The exact error is in the output above -
echo   the last few red lines are the useful part.
echo.
echo   Common causes:
echo     * port 8080 already in use -^> run start.ps1 with -Port 8081
echo     * npm install failed       -^> check the internet connection
echo     * antivirus blocked node   -^> allow node.exe and retry
echo.

:end
echo.
echo   ================================================================
echo   This window is staying open on purpose so the text above can be
echo   read or screenshotted. Press any key to close it.
echo   ================================================================
echo.
pause
