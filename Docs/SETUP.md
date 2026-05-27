# Setup

## Requirements

- Node.js 18+.
- BrowserBridge relay running on `http://localhost:9223`.
- BrowserBridge extension loaded in a Chromium/Opera browser.
- A logged-in `https://chatgpt.com` tab.

## Quick Start

From the workspace root:

```bat
start-agent.bat
```

This starts:

- BrowserBridge relay on `:9223`
- ChatGPT proxy on `:9225`
- File server on `:9226`

Stop all services:

```bat
stop-agent.bat
```

## Manual Start

Start BrowserBridge:

```bash
cd ../browser-bridge
node relay.js
```

Start the ChatGPT proxy:

```bash
cd ../chatgpt-proxy
npm start
```

Start the file server:

```bash
node src/file-server.js
```

## Browser Extension

1. Open `opera://extensions` or `chrome://extensions`.
2. Enable developer mode.
3. Load unpacked extension from `browser-bridge/extension/`.
4. Confirm the badge shows `ON`.
5. Keep a logged-in `https://chatgpt.com` tab open.

Reload the extension after changing `extension/background.js`.

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
|---|---:|---|
| `PORT` | `9225` | ChatGPT proxy listen port |

## Troubleshooting

- If `/v1/models` fails, restart the proxy.
- If `/tabs` fails, restart BrowserBridge relay and reload the extension.
- If chat requests fail with no ChatGPT tab found, open and log into `https://chatgpt.com`.
- If the bridge shows disconnected, reload the extension once.
- If ChatGPT hangs, reload the ChatGPT tab and retry.
