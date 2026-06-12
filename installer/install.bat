@echo off
setlocal EnableDelayedExpansion

set GITHUB_OWNER=vishalegnition
set REPO=egnition-qa-runner
set INSTALL_DIR=%USERPROFILE%\.egnition-qa-runner
set CHROME_PROFILE=%USERPROFILE%\.egnition-qa-chrome
set ZIP_URL=https://github.com/%GITHUB_OWNER%/%REPO%/archive/refs/heads/main.zip
set LOCAL_PORT=3000
set CHROME_PORT=9222

echo.
echo  Egnition QA Runner - Windows Installer
echo  =====================================
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js not found. Downloading installer...
  powershell -NoProfile -Command ^
    "$url='https://nodejs.org/dist/v20.18.0/node-v20.18.0-x64.msi'; $out=$env:TEMP+'\node-install.msi'; Invoke-WebRequest -Uri $url -OutFile $out; Start-Process msiexec.exe -ArgumentList '/i',$out,'/passive' -Wait"
  echo.
  echo Node.js installed. Please re-run this script.
  pause
  exit /b 0
)

echo [1/5] Downloading latest runner from GitHub...
set TEMP_ZIP=%TEMP%\qa-runner.zip
set TEMP_EXTRACT=%TEMP%\qa-runner-extract
powershell -NoProfile -Command "Invoke-WebRequest -Uri '%ZIP_URL%' -OutFile '%TEMP_ZIP%'"
if errorlevel 1 (
  echo Failed to download runner. Check your internet connection.
  pause
  exit /b 1
)

if exist "%TEMP_EXTRACT%" rmdir /s /q "%TEMP_EXTRACT%"
powershell -NoProfile -Command "Expand-Archive -Path '%TEMP_ZIP%' -DestinationPath '%TEMP_EXTRACT%' -Force"
if not exist "%INSTALL_DIR%" mkdir "%INSTALL_DIR%"
xcopy /E /Y /I "%TEMP_EXTRACT%\%REPO%-main\*" "%INSTALL_DIR%\" >nul

echo [2/5] Installing dependencies...
cd /d "%INSTALL_DIR%"
call npm install --omit=dev
if errorlevel 1 (
  echo npm install failed.
  pause
  exit /b 1
)

echo [3/5] Launching QA Chrome on port %CHROME_PORT%...
set CHROME_EXE=
if exist "C:\Program Files\Google\Chrome\Application\chrome.exe" set CHROME_EXE=C:\Program Files\Google\Chrome\Application\chrome.exe
if exist "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" set CHROME_EXE=C:\Program Files (x86)\Google\Chrome\Application\chrome.exe

if "%CHROME_EXE%"=="" (
  echo Google Chrome not found. Please install Chrome and try again.
  pause
  exit /b 1
)

netstat -ano | findstr ":%CHROME_PORT% " | findstr LISTENING >nul
if errorlevel 1 (
  start "" "%CHROME_EXE%" --remote-debugging-port=%CHROME_PORT% --user-data-dir="%CHROME_PROFILE%" --no-first-run --no-default-browser-check
  timeout /t 3 /nobreak >nul
) else (
  echo QA Chrome already running on port %CHROME_PORT%
)

echo [4/5] Starting local server on port %LOCAL_PORT%...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%LOCAL_PORT% " ^| findstr LISTENING') do (
  taskkill /F /PID %%a >nul 2>&1
)
timeout /t 1 /nobreak >nul

cd /d "%INSTALL_DIR%"
set EGNITION_QA_HOME=%INSTALL_DIR%
start "Egnition QA Runner" /B cmd /c "node server\index.js >> %INSTALL_DIR%\server.log 2>&1"
timeout /t 2 /nobreak >nul

echo [5/5] Opening web app...
start http://localhost:%LOCAL_PORT%

echo.
echo  Done! Log into your dev store in QA Chrome if prompted, then run tests.
echo  Server log: %INSTALL_DIR%\server.log
echo.
pause
