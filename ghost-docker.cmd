@echo off
rem ghost-docker, from cmd.exe or a double click.
rem
rem All of the logic is in ghost-docker.ps1 beside this file. This only starts it,
rem and does so in a way that works where running .ps1 files is disabled by the
rem default execution policy. Windows PowerShell 5.1 ships with Windows.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0ghost-docker.ps1" %*
exit /b %ERRORLEVEL%
