# Browser Worker

Backend privado que substitui a extensao BrowserBridge para deploy. Ele abre um Chrome/Chromium com CDP, usa um perfil persistente logado no ChatGPT e expoe apenas o subset HTTP que o `chatgpt-proxy` precisa.

## Fluxo

```text
cliente -> chatgpt-proxy :9225 -> browser-worker :9233 -> Chrome CDP :9224 -> chatgpt.com
```

O worker deve ficar em `127.0.0.1` ou rede privada. Nao exponha `:9233` nem `:9224` na internet.

## Primeiro login

Rode o helper de login em modo visivel. Ele abre o Chrome com o mesmo perfil persistente usado pelo worker e espera ate detectar o composer do ChatGPT:

```bat
cd chatgpt-proxy
npm run login
```

Complete o login na janela do Chrome. Quando o composer for detectado, o helper vai esperar voce pressionar Enter antes de encerrar. Isso evita fechar a janela antes de terminar o login.

Depois que o login for detectado, o worker consegue gerar as requisicoes porque usa esse mesmo perfil/cookies no Chrome controlado por CDP.

Inicie o worker:

```bat
npm run worker
```

Depois configure o proxy para usar o worker:

```bat
set "BROWSER_BACKEND_URL=http://127.0.0.1:9233"
node src\proxy.js
```

## Variaveis uteis

```text
CHATGPT_WORKER_HOST=127.0.0.1
CHATGPT_WORKER_PORT=9233
CHATGPT_CDP_HOST=127.0.0.1
CHATGPT_CDP_PORT=9224
CHATGPT_USER_DATA_DIR=C:\yk-chatgpt-profile
CHATGPT_CHROME_PATH=C:\Program Files\Google\Chrome\Application\chrome.exe
CHATGPT_HEADLESS=0
BROWSER_BACKEND_URL=http://127.0.0.1:9233
PROXY_API_KEY=troque-isto # opcional, somente se quiser exigir auth no proxy
```

Use `CHATGPT_HEADLESS=1` apenas depois de validar que a sessao logada funciona sem desafio visual.

## Producao

- Publique somente o `chatgpt-proxy` atras de HTTPS, auth e rate limit.
- Defina `PROXY_API_KEY` no proxy se for publicar para terceiros.
- Deixe `browser-worker` e CDP bindados em loopback.
- Use um perfil de Chrome por conta/sessao.
- Nunca salve logs com cookies, headers ou corpos raw de requisicoes.
- Use apenas contas e sessoes que voce esta autorizado a operar.
