@echo off
setlocal
rem ---------------------------------------------------------------------------
rem  Starts a dedicated Chrome window with the DevTools port open, so the
rem  "My Model" plugin can send ChatGPT requests from inside a real browser.
rem  The profile is separate from your everyday one because Chrome 136+ refuses
rem  remote debugging on the default profile. Sign in to chatgpt.com once in
rem  this window and keep it open while the Harness is running.
rem ---------------------------------------------------------------------------

set "CHROME=C:\Program Files\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if not exist "%CHROME%" set "CHROME=C:\Program Files\Microsoft\Edge\Application\msedge.exe"

if not exist "%CHROME%" (
  echo Could not find chrome.exe or msedge.exe.
  echo Open this file in Notepad and set CHROME to your browser's full path.
  pause
  exit /b 1
)

set "PROFILE=%LOCALAPPDATA%\dsh-chrome"

echo Browser : %CHROME%
echo Profile : %PROFILE%
echo Port    : 127.0.0.1:9222  ^(loopback only^)
echo.
echo Keep this window open while the Harness uses ChatGPT.
echo First run: sign in to https://chatgpt.com in the window that just opened.
echo.

start "" "%CHROME%" --remote-debugging-port=9222 --user-data-dir="%PROFILE%" "https://chatgpt.com/"

timeout /t 4 >nul
exit /b 0
