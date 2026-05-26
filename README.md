# ChatGPT Proxy

OpenAI-compatible HTTP proxy for ChatGPT. Works by relaying requests through a browser-bridge CDP session.

```bash
curl http://localhost:9225/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"chatgpt-web","messages":[{"role":"user","content":"Hello"}]}'
```

## How it works

1. Chrome with remote debugging loads chatgpt.com
2. `relay.js` exposes cookies via HTTP on `:9223`
3. `proxy.js` uses those cookies to call ChatGPT's internal API
4. Translates the SSE delta-encoded response into OpenAI format

## Usage

See [Docs/SETUP.md](Docs/SETUP.md) for setup instructions.

## Architecture

See [Docs/ARCHITECTURE.md](Docs/ARCHITECTURE.md) for the request flow and SSE parsing details.

## Status

- ✅ Single-turn chat
- ✅ Multi-turn (conversation history)
- ✅ OpenAI-compatible response format
- ❌ Streaming (planned)
- ❌ Auto-refresh on 401 (planned)

## License

MIT
