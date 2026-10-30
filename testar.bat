@echo off
setlocal
pushd "%~dp0"
if not exist ".venv\Scripts\python.exe" goto sem_venv
".venv\Scripts\python.exe" tests\run_all.py
set "IBE_TEST_RESULT=%ERRORLEVEL%"
popd
exit /b %IBE_TEST_RESULT%

:sem_venv
echo Nao encontrei .venv\Scripts\python.exe. Veja Desenvolvimento no README.
popd
exit /b 1
