# ChatGPT Proxy

Proxy HTTP OpenAI-compatible para usar uma sessão real do ChatGPT Web como backend, sem expor a extensão BrowserBridge. A versão de produção usa um `browser-worker` privado dentro deste próprio repositório.

## Instalação rápida

Requisitos:

- Node.js 22 ou superior.
- Google Chrome, Microsoft Edge, Brave ou Chromium instalado.
- Git instalado.
- Uma conta do ChatGPT que você está autorizado a usar.

Comando direto de instalação no Windows CMD:

```cmd
git clone https://github.com/taipgonesistema-cloud/chatgpt-proxy.git && cd chatgpt-proxy && npm install
```

No Linux/macOS:

```bash
git clone https://github.com/taipgonesistema-cloud/chatgpt-proxy.git && cd chatgpt-proxy && npm install
```

## Como rodar

### 1. Fazer login no ChatGPT

Rode:

```bash
npm run login
```

No Windows também pode usar:

```cmd
scripts\login.cmd
```

Esse comando abre um Chrome visível usando um perfil persistente do worker. Faça login no `https://chatgpt.com`. Quando o composer do ChatGPT for detectado, o helper vai pedir para apertar Enter.

### 2. Iniciar o browser-worker

Em um terminal separado:

```bash
npm run worker
```

No Windows também pode usar:

```cmd
scripts\start-worker.cmd
```

O worker fica em:

```text
http://127.0.0.1:9233
```

Ele controla o Chrome via CDP em:

```text
127.0.0.1:9224
```

Não exponha o worker nem o CDP publicamente.

### 3. Iniciar o proxy OpenAI-compatible

Em outro terminal:

```cmd
set BROWSER_BACKEND_URL=http://127.0.0.1:9233
npm start
```

No Windows também pode usar:

```cmd
scripts\start-proxy.cmd
```

No Linux/macOS:

```bash
export BROWSER_BACKEND_URL=http://127.0.0.1:9233
npm start
```

Auth é opcional. Para exigir chave, defina `PROXY_API_KEY` antes de iniciar o proxy:

```cmd
set "PROXY_API_KEY=troque-esta-chave"
scripts\start-proxy.cmd
```

O proxy fica em:

```text
http://localhost:9225
```

## Endpoint OpenAI-compatible

Base URL para clientes OpenAI-compatible:

```text
http://localhost:9225/v1
```

Modelo:

```text
chatgpt-web
```

Endpoints disponíveis:

| Método | Endpoint | Uso |
|---|---|---|
| `GET` | `/v1` | Descoberta da API compatível |
| `GET` | `/v1/models` | Lista modelos |
| `POST` | `/v1/chat/completions` | Chat completions OpenAI-compatible |

Por padrão não há API key. Se `PROXY_API_KEY` estiver definido pelo usuário, envie:

```text
Authorization: Bearer troque-esta-chave
```

## Testes rápidos

Descoberta `/v1`:

```bash
curl http://localhost:9225/v1
```

Listar modelos:

```bash
curl http://localhost:9225/v1/models
```

Chat sem streaming:

```bash
curl http://localhost:9225/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"chatgpt-web","messages":[{"role":"user","content":"Responda exatamente: ok"}]}'
```

Chat com streaming:

```bash
curl http://localhost:9225/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"chatgpt-web","stream":true,"messages":[{"role":"user","content":"Responda exatamente: stream-ok"}]}'
```

## Exemplo com OpenAI SDK

JavaScript:

```js
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://localhost:9225/v1",
  apiKey: "sem-chave",
});

const response = await client.chat.completions.create({
  model: "chatgpt-web",
  messages: [{ role: "user", content: "Responda exatamente: sdk-ok" }],
});

console.log(response.choices[0].message.content);
```

Python:

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:9225/v1",
    api_key="sem-chave",
)

response = client.chat.completions.create(
    model="chatgpt-web",
    messages=[{"role": "user", "content": "Responda exatamente: sdk-ok"}],
)

print(response.choices[0].message.content)
```

## Uso com pi.dev

O [pi.dev](https://pi.dev) é um agente de terminal que funciona nativamente com este proxy. Configure o arquivo de modelos em `~/.pi/agent/models.json`:

```json
{
  "providers": {
    "chatgpt-web": {
      "baseUrl": "http://localhost:9225/v1",
      "api": "openai-completions",
      "apiKey": "SUBSTITUA SE FOR USAR",
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false
      },
      "models": [{ "id": "chatgpt-web" }]
    }
  }
}
```

### Sem tools (chat simples)

```bash
pi --offline --no-tools --model chatgpt-web/chatgpt-web -p "Responda exatamente: pi-ok"
```

### Com tools (bash, leitura de arquivos, etc.)

```bash
pi --offline --model chatgpt-web/chatgpt-web -p "Use uma ferramenta para ver onde estamos e responda apenas com o caminho atual."
```

O proxy converte automaticamente chamadas de ferramenta do prompt em `tool_calls` OpenAI-compatible. Pi executa a ferramenta e retorna o resultado numa chamada seguinte.

Maior compatibilidade: use sempre `--offline` para evitar processamento cloud que pode conflitar com o modelo `chatgpt-web`. O modelo `chatgpt-web` não suporta `developer` role nem `reasoning_effort`; essas flags são ignoradas automaticamente pelo proxy.

## Variáveis de ambiente

| Variável | Padrão | Descrição |
|---|---|---|
| `PORT` | `9225` | Porta do proxy OpenAI-compatible |
| `PROXY_API_KEY` | vazio | Chave opcional. Se definida, exige `Authorization: Bearer` |
| `BROWSER_BACKEND_URL` | `http://localhost:9223` | Backend de browser usado pelo proxy. Em produção use `http://127.0.0.1:9233` |
| `CHATGPT_WORKER_HOST` | `127.0.0.1` | Host do browser-worker |
| `CHATGPT_WORKER_PORT` | `9233` | Porta do browser-worker |
| `CHATGPT_CDP_HOST` | `127.0.0.1` | Host do Chrome DevTools Protocol |
| `CHATGPT_CDP_PORT` | `9224` | Porta do Chrome DevTools Protocol |
| `CHATGPT_USER_DATA_DIR` | perfil local do usuário | Perfil persistente usado para salvar o login do ChatGPT |
| `CHATGPT_CHROME_PATH` | autodetectado | Caminho do executável do Chrome/Edge/Brave/Chromium |
| `CHATGPT_HEADLESS` | `0` | Use `1` somente depois de validar login e desafios em modo visível |

## Como funciona

1. O cliente chama `/v1/chat/completions` como se fosse uma API OpenAI.
2. O proxy monta o prompt final e chama o `browser-worker`.
3. O worker usa o Chrome real com perfil logado no ChatGPT.
4. O Chrome gera uma requisição válida para `/backend-api/f/conversation`.
5. O worker intercepta essa requisição via CDP `Fetch.requestPaused` e troca apenas o body.
6. Headers, cookies e tokens frescos continuam sendo gerados pelo browser real.
7. O proxy converte a resposta do ChatGPT para JSON ou SSE OpenAI-compatible.

## Produção

Para expor para outras pessoas, exponha somente o proxy `:9225` atrás de HTTPS, auth e rate limit.

Não exponha estes serviços:

```text
browser-worker :9233
Chrome CDP :9224
perfil do Chrome
cookies ou logs raw
```

Recomendado:

- Definir `PROXY_API_KEY` forte.
- Usar HTTPS no gateway/reverse proxy.
- Colocar rate limit por usuário.
- Usar um perfil de Chrome por conta/sessão.
- Rodar worker e CDP apenas em `127.0.0.1` ou rede privada.
- Nunca commitar perfil, cookies, traces raw, headers sensíveis ou logs de requisição.

## Scripts

| Script | Descrição |
|---|---|
| `npm run login` | Abre Chrome visível e prepara o perfil logado |
| `npm run worker` | Inicia o browser-worker privado |
| `npm start` | Inicia o proxy OpenAI-compatible |
| `scripts\login.cmd` | Atalho Windows para login |
| `scripts\start-worker.cmd` | Atalho Windows para iniciar o worker |
| `scripts\start-proxy.cmd` | Atalho Windows para iniciar o proxy com `BROWSER_BACKEND_URL` padrão |

## Headless

O worker aceita `CHATGPT_HEADLESS=1`, mas o teste local caiu em verificação do ChatGPT (`Um momento...`) e não chegou no composer. Para produção, prefira Chrome headful em VM/display virtual e mantenha worker/CDP privados.

## Status

- `/v1` discovery endpoint.
- `/v1/models`.
- `/v1/chat/completions` sem streaming.
- `/v1/chat/completions` com streaming SSE.
- Auth opcional por `PROXY_API_KEY`.
- Browser worker privado sem extensão exposta.
- Compatibilidade com clientes OpenAI chat completions.

## Aviso

Use apenas contas e sessões que você está autorizado a operar. Este projeto depende do comportamento do ChatGPT Web e pode precisar de ajustes se o site mudar DOM, fluxo de rede ou formato dos eventos.
