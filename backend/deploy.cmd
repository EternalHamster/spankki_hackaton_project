@echo off
setlocal
set "COACH_PYTHON="
if exist "%~dp0.venv\Scripts\python.exe" set "COACH_PYTHON=%~dp0.venv\Scripts\python.exe"
if not defined COACH_PYTHON if exist "%~dp0..\.venv\Scripts\python.exe" set "COACH_PYTHON=%~dp0..\.venv\Scripts\python.exe"
if not defined COACH_PYTHON if exist "%~dp0..\..\.venv\Scripts\python.exe" set "COACH_PYTHON=%~dp0..\..\.venv\Scripts\python.exe"
if not defined COACH_PYTHON set "COACH_PYTHON=python"
"%COACH_PYTHON%" -u "%~dp0scripts\cloud_run.py" %*
exit /b %ERRORLEVEL%
