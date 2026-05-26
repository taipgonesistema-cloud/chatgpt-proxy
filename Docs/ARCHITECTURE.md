# Architecture

## Overview

```
Client (OpenAI SDK / curl / test.html)
        |
        v  POST /v1/chat/completions
  chatgpt-proxy (port 9225)
        |
        v  relays cookies via HTTP
  browser-bridge relay (port 9223)
        |  (Chrome DevTools Protocol)
        v
  chatgpt.com (real ChatGPT API)
```

The proxy translates the OpenAI `/v1/chat/completions` format into ChatGPT's internal API calls.

## Request Flow

1. **Sentinel** `POST /backend-api/sentinel/chat-requirements/prepare`
   - Body: `{}`
   - Returns `prepare_token` for the next step

2. **Conversation Prepare** `POST /backend-api/f/conversation/prepare`
   - Body: full conversation context (messages, parent_message_id, model, etc.)
   - Returns `conduit_token` for the main call

3. **Conversation** `POST /backend-api/f/conversation`
   - Body: full conversation with metadata
   - Returns SSE stream with delta-encoded response

## SSE Parsing

ChatGPT uses delta-encoding with three event patterns:

| Pattern | Meaning |
|---------|---------|
| `{"p":"/message/content/parts/0", "o":"append", "v":"text"}` | Append text to assistant message |
| `{"v": "text continuation"}` | Shorthand — inherits `p` and `o` from previous event |
| `{"o":"patch", "v":[{sub-operations}]}` | Batch of operations, may include text append |

The parser tracks `lastP` / `lastO` to handle shorthand events, and recurses into `patch` arrays.

## Multi-turn

`convState` stores `conversation_id` and `parent_message_id` (last assistant message ID). Each request passes these so ChatGPT sees the full conversation history.

## Session

Cookies are fetched from the browser via browser-bridge relay and cached for 30s. `oai-device-id` is extracted from the `oai-did` cookie.
