@echo off
setlocal
call "%~dp0_config.bat" || exit /b 1
set "DEST=%BASE%\gexlab_copias"
if not exist "%DEST%" mkdir "%DEST%"
echo Creando una copia nueva en el servidor...
%SSH% "bash ~/gexlab/servidor/copia.sh" || (echo Error & pause & exit /b 1)
%SSH% "ls -1t ~/gexlab/backups/gexlab_*.tgz | head -1" > "%TEMP%\gexlast.txt"
set /p LAST=<"%TEMP%\gexlast.txt"
%SCP% ubuntu@%IP%:%LAST% "%DEST%\" && echo Guardada en %DEST%
pause
