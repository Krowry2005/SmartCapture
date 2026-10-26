@echo off
rem スマホへ APK をインストールする (ダブルクリック可)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-android.ps1" %*
set RESULT=%ERRORLEVEL%
pause
exit /b %RESULT%
