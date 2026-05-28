# Architecture

## Overview

```text
OpenAI client / Pi / UI
        |
        v
  chatgpt-proxy :9225
        |
        v
  browser-worker :9233  (Node.js CDP client)
        |
        v
  Chrome DevTools Protocol :9224
        |
        v
  logged-in ChatGPT tab
```

The proxy does not replay captured ChatGPT credentials. Instead, it lets the browser create a valid ChatGPT request and rewrites only the POST body before the request leaves the browser.

## Main Components

| Component | Responsibility |
|---|---|
| `src/proxy.js` | OpenAI-compatible API, prompt/tool conversion, CDP orchestration, SSE conversion |
| `src/file-server.js` | Local project file actions for the web UI |
| `worker/worker.cjs` | CDP client that controls Chrome directly (replaces BrowserBridge relay + extension) |
| `worker/login.cjs` | Helper to log into ChatGPT with a visible Chrome window |

## Request Flow

1. Client sends `POST /v1/chat/completions`.
2. The proxy builds a single ChatGPT prompt from OpenAI messages, tool schemas, and the Pi agent contract.
3. The proxy starts network capture on the worker (`/networkStart`).
4. The proxy starts Fetch rewrite on the worker (`/rewriteConversationStart`).
5. The proxy triggers ChatGPT's composer with a placeholder via the worker.
6. The worker receives `Fetch.requestPaused` for the real conversation POST.
7. The worker replaces the body with the desired prompt and continues the request.
8. The browser sends the request with valid ChatGPT-generated headers/tokens.
9. The proxy polls `/networkResponses` on the worker and parses WebSocket `encoded_item` frames.
10. The proxy returns OpenAI-compatible JSON or `text/event-stream` chunks.

## Why Not Direct HTTPS

Direct HTTPS calls with captured headers failed with 403 because Turnstile/proof/sentinel tokens are tied to a fresh browser request. CDP rewrite keeps those headers fresh by preserving the browser's request and changing only the body.

## Streaming Parser

ChatGPT WebSocket frames contain `encoded_item` strings with SSE-like data. Text deltas can appear as:

| Shape | Meaning |
|---|---|
| `{"p":"/message/content/parts/0","o":"append","v":"text"}` | Append text |
| `{"v":"continued text"}` | Pathless continuation |
| `{"o":"patch","v":[...]}` | Patch list with append operations |

The parser deduplicates frames by both `stream_item_id` and encoded payload. Deduplicating only by `stream_item_id` can truncate responses because multiple chunks can share context.

## Tool Calling

ChatGPT Web does not expose native OpenAI tool calls, so the proxy uses a prompt contract:

```text
<tool_call>{"name":"tool_name","arguments":{"arg":"value"}}</tool_call>
```

The proxy parses those wrappers and emits OpenAI-compatible `tool_calls` with `finish_reason: "tool_calls"`. Pi then executes the tool and sends the result back in a follow-up request.

## Concurrency

`src/proxy.js` serializes requests with an in-process queue because one browser tab/composer is used as the transport. This avoids overlapping rewrites and mixed WebSocket captures.

## Limitations

- Requires a live logged-in ChatGPT tab.
- Requires a Chrome instance with remote debugging enabled (`--remote-debugging-port=9224`).
- One request at a time per proxy process.
- ChatGPT DOM selectors and transport details can change.
- Tool calls are prompt-based and can require parser/prompt updates if model formatting changes.
- Headless mode is not reliable; ChatGPT shows a verification screen that blocks token capture.
