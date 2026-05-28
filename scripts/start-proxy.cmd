@echo off
setlocal
cd /d "%~dp0\.."

if "%BROWSER_BACKEND_URL%"=="" set "BROWSER_BACKEND_URL=http://127.0.0.1:9233"

if "%PROXY_API_KEY%"=="" (
  echo [AVISO] PROXY_API_KEY nao definido. O proxy vai iniciar sem auth.
  echo [AVISO] Para publicar na internet, defina antes: set "PROXY_API_KEY=minha-chave-forte"
)

npm start
