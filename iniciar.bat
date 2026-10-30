@echo off
setlocal
cd /d "%~dp0"
if "%~1"=="abrir" goto abrir
title Ibe Music
set "PATH=%LOCALAPPDATA%\Microsoft\WinGet\Links;%PATH%"
if exist ".venv\ok" goto rodar
echo.
echo  Preparando o Ibe Music. So na primeira vez: precisa de internet e pode levar varios minutos...
echo.
call :achar_python
if defined PY goto tem_python
echo  Instalando o Python 3.11...
winget install --id Python.Python.3.11 -e --silent --accept-package-agreements --accept-source-agreements
call :achar_python
if not defined PY goto sem_python
:tem_python
where ffmpeg >nul 2>&1 && goto tem_ffmpeg
echo  Instalando o FFmpeg...
winget install --id Gyan.FFmpeg -e --silent --accept-package-agreements --accept-source-agreements
:tem_ffmpeg
%PY% -m venv .venv || goto erro
".venv\Scripts\python.exe" -m pip install --upgrade pip || goto erro
".venv\Scripts\python.exe" -m pip install -r requirements.txt || goto erro
echo.
echo  Baixando os modelos de separacao de faixas...
".venv\Scripts\python.exe" -c "import separator; separator.preload()" || goto erro
echo ok> ".venv\ok"
:rodar
start "" /b cmd /c call "%~f0" abrir
".venv\Scripts\python.exe" app.py
pause
exit /b 0

:achar_python
set "PY="
py -3.11 --version >nul 2>&1 && set "PY=py -3.11" && exit /b 0
if exist "%LOCALAPPDATA%\Programs\Python\Python311\python.exe" set PY="%LOCALAPPDATA%\Programs\Python\Python311\python.exe"
if defined PY exit /b 0
if exist "%ProgramFiles%\Python311\python.exe" set PY="%ProgramFiles%\Python311\python.exe"
if defined PY exit /b 0
python -c "import sys; sys.exit(0 if (3,10) <= sys.version_info[:2] <= (3,12) else 1)" >nul 2>&1 && set "PY=python"
exit /b 0

:abrir
set /a N=0
:esperar
ping -n 3 127.0.0.1 >nul
set /a N+=1
curl -s -o nul http://127.0.0.1:7860/api/health && goto janela
if %N% lss 40 goto esperar
:janela
set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" goto navegador
start "" "%EDGE%" --app=http://localhost:7860
exit /b 0
:navegador
start "" http://localhost:7860
exit /b 0

:sem_python
echo.
echo  Nao consegui instalar o Python sozinho.
echo  Baixe o Python 3.11.9 em python.org - Windows installer 64-bit - marque "Add python.exe to PATH"
echo  e depois abra este arquivo de novo.
pause
exit /b 1

:erro
echo.
echo  Algo deu errado na instalacao. Confira a internet, apague a pasta .venv e tente de novo.
pause
exit /b 1
