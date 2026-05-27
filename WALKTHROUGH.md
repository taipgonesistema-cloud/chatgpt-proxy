# ChatGPT Browser-Backed Proxy Walkthrough

## Objective

Expose a local OpenAI-compatible API at `http://localhost:9225/v1` backed by the real ChatGPT web app in a logged-in browser tab.

The key requirement is to preserve ChatGPT's browser-generated authentication, Turnstile, proof, sentinel, conduit, and tracing headers instead of trying to recreate or reuse them from Node.js.

## Final Architecture

```text
OpenAI client / Pi
  -> chatgpt-proxy :9225
  -> BrowserBridge relay :9223
  -> BrowserBridge extension
  -> CDP Fetch.requestPaused rewrite
  -> real ChatGPT /backend-api/f/conversation request
  -> WebSocket frames captured by CDP Network
  -> OpenAI-compatible response/SSE
```

## Why CDP Rewrite

Direct HTTPS calls failed because ChatGPT's Turnstile/proof tokens are single-use and tied to the browser request flow. Replaying captured headers resulted in 403 responses such as "Unusual activity has been detected".

The working approach is:

1. Let the ChatGPT page create a real request naturally.
2. Pause that request with CDP `Fetch.requestPaused` before it leaves the browser.
3. Replace only the POST body.
4. Continue the request with the original fresh browser headers intact.
5. Capture the response from browser WebSocket frames.

## Request Flow

1. Client calls `POST /v1/chat/completions` on `:9225`.
2. `proxy.js` builds a prompt from full message history and tool schemas.
3. `proxy.js` calls BrowserBridge `/networkStart` for `/backend-api/f/conversation`.
4. `proxy.js` calls BrowserBridge `/rewriteConversationStart` with the desired prompt.
5. `proxy.js` triggers ChatGPT's composer with a placeholder message.
6. `extension/background.js` catches `Fetch.requestPaused` for the real conversation POST.
7. The extension rewrites the first user message body or uses explicit `postData`.
8. The request continues with valid ChatGPT browser headers.
9. `proxy.js` reads `/networkResponses` and extracts assistant deltas from `encoded_item` frames.
10. The proxy returns either OpenAI JSON or OpenAI SSE chunks.

## Pi Tool Calling

`proxy.js` injects two prompt contracts:

- Agent behavior contract: inspect before answering, avoid guessing, make minimal changes, verify with tools when possible.
- Tool contract: emit exactly `<tool_call>{"name":"...","arguments":{...}}</tool_call>` when Pi should execute a tool.

When ChatGPT emits valid tool wrappers, the proxy converts them into OpenAI-compatible `tool_calls` so Pi can execute them.

Example expected model text:

```text
<tool_call>{"name":"bash","arguments":{"command":"pwd","timeout":10}}</tool_call>
```

Example OpenAI stream output:

```text
data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_...","type":"function","function":{"name":"bash","arguments":"{\"command\":\"pwd\",\"timeout\":10}"}}]},"finish_reason":null}]}

data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}

data: [DONE]
```

## Important Parser Detail

ChatGPT WebSocket `encoded_item` frames can append text in multiple forms:

- `{ "p": "/message/content/parts/0", "o": "append", "v": "..." }`
- `{ "v": "..." }` where the prior path is implied
- `{ "o": "patch", "v": [{ "p": "/message/content/parts/0", "o": "append", "v": "..." }] }`

The parser must include all three. Ignoring the pathless `{ "v": "..." }` form truncates tool calls.

## Services

| Service | Port | File |
|---|---:|---|
| BrowserBridge relay | `9223` | `../browser-bridge/relay.js` |
| ChatGPT proxy | `9225` | `src/proxy.js` |
| File server | `9226` | `src/file-server.js` |

## Start And Stop

From the workspace root:

```bat
start-agent.bat
stop-agent.bat
```

## Smoke Tests

Proxy model endpoint:

```bash
node -e "fetch('http://localhost:9225/v1/models').then(r=>r.text()).then(console.log)"
```

Pi model:

```bash
pi --offline --model chatgpt-web/chatgpt-web -p "Responda exatamente: pi-ok"
```

Pi tool use:

```bash
pi --offline --model chatgpt-web/chatgpt-web -p "Use uma ferramenta para ver onde estamos e responda apenas com o caminho atual."
```

## Current Limitations

- Requires a logged-in ChatGPT tab.
- Still uses a visible composer send to trigger a real browser request.
- One tab means requests are serialized.
- Tool calling is prompt-based and may need future prompt/parser hardening if ChatGPT output changes.
- BrowserBridge extension must be reloaded after service worker changes.
