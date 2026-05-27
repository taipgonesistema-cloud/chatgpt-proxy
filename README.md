# ChatGPT Proxy

OpenAI-compatible HTTP proxy backed by a real authenticated ChatGPT browser tab.

The proxy runs on `http://localhost:9225` and uses BrowserBridge on `http://localhost:9223` to trigger a real ChatGPT request, rewrite its outgoing `/backend-api/f/conversation` POST body through CDP `Fetch.requestPaused`, and parse the browser's WebSocket response back into OpenAI-compatible JSON or SSE.

## Services

| Service | Port | Purpose |
|---|---:|---|
| BrowserBridge relay | `9223` | HTTP/WebSocket bridge to the browser extension |
| ChatGPT proxy | `9225` | OpenAI-compatible `/v1` API and web UI |
| File server | `9226` | Local project file tree/actions for the UI |

From the workspace root:

```bat
start-agent.bat
```

Stop everything:

```bat
stop-agent.bat
```

Open the UI:

```text
http://localhost:9225/
```

## Requirements

- A Chromium/Opera browser with the BrowserBridge extension loaded.
- A logged-in `https://chatgpt.com` tab.
- BrowserBridge relay running on `:9223`.
- ChatGPT proxy running on `:9225`.

If the relay is connected but requests fail, reload the BrowserBridge extension once and keep a ChatGPT tab open.

## API Usage

Models:

```bash
curl http://localhost:9225/v1/models
```

Non-streaming chat:

```bash
curl http://localhost:9225/v1/chat/completions ^
  -H "Content-Type: application/json" ^
  -d "{\"model\":\"chatgpt-web\",\"messages\":[{\"role\":\"user\",\"content\":\"Hello\"}]}"
```

Streaming chat:

```bash
curl http://localhost:9225/v1/chat/completions ^
  -H "Content-Type: application/json" ^
  -d "{\"model\":\"chatgpt-web\",\"stream\":true,\"messages\":[{\"role\":\"user\",\"content\":\"Say ok\"}]}"
```

## Pi Coding Agent

Add this provider to `~/.pi/agent/models.json`:

```json
{
  "providers": {
    "chatgpt-web": {
      "baseUrl": "http://localhost:9225/v1",
      "api": "openai-completions",
      "apiKey": "dummy",
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false
      },
      "models": [
        {
          "id": "chatgpt-web",
          "name": "ChatGPT Web Proxy",
          "reasoning": false,
          "input": ["text"],
          "contextWindow": 128000,
          "maxTokens": 8192,
          "cost": {
            "input": 0,
            "output": 0,
            "cacheRead": 0,
            "cacheWrite": 0
          }
        }
      ]
    }
  }
}
```

Run Pi with the proxy model:

```bash
pi --offline --model chatgpt-web/chatgpt-web
```

The proxy injects a strict agent/tool contract so ChatGPT emits Pi-compatible tool calls like:

```text
<tool_call>{"name":"bash","arguments":{"command":"pwd","timeout":10}}</tool_call>
```

## How It Works

1. The proxy receives an OpenAI-compatible chat request.
2. It builds a prompt from full message history, system/developer/user/tool messages, and OpenAI tool schemas.
3. BrowserBridge starts network capture and CDP request rewriting.
4. The proxy triggers the ChatGPT composer with a placeholder message.
5. The extension intercepts the real `/backend-api/f/conversation` request before it leaves the browser.
6. The extension rewrites the POST body with the desired prompt while preserving fresh browser-generated headers/tokens.
7. The proxy reads ChatGPT WebSocket frames from BrowserBridge and converts deltas to OpenAI chat completions.

This avoids reusing Turnstile/proof tokens directly, which fails because those tokens are single-use and bound to the browser flow.

## Status

- OpenAI-compatible `/v1/models`
- OpenAI-compatible `/v1/chat/completions`
- Streaming SSE responses
- Pi custom provider support
- Pi tool-call translation via `<tool_call>` wrappers
- Full message/history prompt injection
- Browser-backed CDP request rewrite
- Local file-server for the UI

## Limitations

- Requires an active logged-in ChatGPT tab.
- Requests are serialized through one browser tab.
- The visible ChatGPT UI is still used to trigger valid browser-side tokens.
- Tool calls rely on prompt discipline, not native ChatGPT API tool calling.
- If ChatGPT changes its web transport or DOM selectors, the proxy may need updates.

## Important Files

| File | Purpose |
|---|---|
| `src/proxy.js` | OpenAI-compatible proxy and ChatGPT orchestration |
| `src/file-server.js` | Local project file server for the UI |
| `test/chatgpt-test.html` | Small streaming test UI |
| `../browser-bridge/relay.js` | Relay used by the proxy |
| `../browser-bridge/extension/background.js` | Extension CDP implementation |

## License

MIT
