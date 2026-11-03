@echo off
rem Lee servidor.txt y prepara las variables comunes
set "IP=" & set "CLAVE=" & set "DOMINIO=" & set "DUCKDNS_TOKEN="
for /f "usebackq eol=# tokens=1,* delims==" %%a in ("%~dp0servidor.txt") do set "%%a=%%b"
if "%IP%"=="" (echo Falta la IP en servidor\servidor.txt & pause & exit /b 1)
if not exist "%CLAVE%" (echo No encuentro la clave %CLAVE% & pause & exit /b 1)
set "SSH=ssh -i "%CLAVE%" -o StrictHostKeyChecking=accept-new ubuntu@%IP%"
set "SCP=scp -i "%CLAVE%" -o StrictHostKeyChecking=accept-new"
set "BASE=%~dp0..\.."
exit /b 0
