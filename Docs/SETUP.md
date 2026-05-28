# Setup

## Requirements

- Node.js 18+.
- Chrome or Chromium browser.
- A logged-in `https://chatgpt.com` tab (see login flow below).

## Quick Start

```bat
git clone https://github.com/taipgonesistema-cloud/chatgpt-proxy.git
cd chatgpt-proxy
npm install
```

### 1. Login

```bat
npm run login
```

Opens a visible Chrome window with a persistent profile. Log into `https://chatgpt.com`, then press Enter in the terminal.

### 2. Start Worker

```bat
npm run worker
```

Starts the browser-worker on `http://127.0.0.1:9233`, which connects to Chrome via CDP (`127.0.0.1:9224`).

### 3. Start Proxy

```bat
npm start
```

Starts the ChatGPT proxy on `http://localhost:9225`.

## Manual Start

Start the worker:

```bash
node worker/worker.cjs
```

Start the ChatGPT proxy:

```bash
node src/proxy.js
```

Start the file server (optional, for the web UI):

```bash
node src/file-server.js
```

## Login

The worker uses a persistent Chrome profile at `%LOCALAPPDATA%\yk-chatgpt-worker-profile`. To log into ChatGPT:

```bat
npm run login
```

This opens Chrome in visible mode with that profile. After you log into `https://chatgpt.com` and the composer field is detected, press Enter in the terminal to close Chrome.

You cannot have two Chrome processes using the same profile simultaneously. Stop the worker before running login.

## API Smoke Tests

Models:

```bash
node -e "fetch('http://localhost:9225/v1/models').then(r=>r.text()).then(console.log)"
```

Streaming chat:

```bash
node -e "fetch('http://localhost:9225/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({stream:true,messages:[{role:'user',content:'Responda exatamente: ok'}]})}).then(async r=>{const rd=r.body.getReader();const d=new TextDecoder();while(true){const x=await rd.read();if(x.done)break;process.stdout.write(d.decode(x.value));}})"
```

## Pi Coding Agent

Configure Pi with provider `chatgpt-web` pointing to:

```text
http://localhost:9225/v1
```

Run:

```bash
pi --offline --model chatgpt-web/chatgpt-web
```

## Configuration

| Env var | Default | Description |
|---|---:|---:|
| `PORT` | `9225` | ChatGPT proxy listen port |
| `BROWSER_BACKEND_URL` | `http://127.0.0.1:9233` | Browser worker URL |
| `PROXY_API_KEY` | (none) | Optional API key for auth |

## Troubleshooting

- If `/v1/models` fails, check that the worker is running and Chrome is open with a logged-in ChatGPT tab.
- If the worker shows connection errors, ensure Chrome is running with `--remote-debugging-port=9224` and no other process is using the same profile.
- If chat requests fail with "no ChatGPT tab found", open and log into `https://chatgpt.com`.
- If ChatGPT hangs, reload the ChatGPT tab and retry.
- If login asks for a new profile, stop the worker first, then run login.
- If you see `403` errors, the ChatGPT session may have expired; run login again.
