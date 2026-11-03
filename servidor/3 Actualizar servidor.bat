@echo off
setlocal
call "%~dp0_config.bat" || exit /b 1
echo Empaquetando solo el codigo (el historial y los usuarios del servidor no se tocan)...
tar -czf "%TEMP%\gexlab_codigo.tgz" --exclude=gexlab/.venv --exclude=gexlab/cache --exclude=gexlab/backups --exclude=gexlab/history --exclude=gexlab/data --exclude=gexlab/watchlist.json --exclude=*/__pycache__ -C "%BASE%" gexlab || (echo Error al empaquetar & pause & exit /b 1)
%SCP% "%TEMP%\gexlab_codigo.tgz" ubuntu@%IP%:gexlab_codigo.tgz || (echo Error al subir & pause & exit /b 1)
%SSH% "bash ~/gexlab/servidor/actualizar.sh"
del "%TEMP%\gexlab_codigo.tgz" 2>nul
pause
