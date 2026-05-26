# Setup

## Requirements

- Node.js 18+
- Chrome with remote debugging enabled
- [browser-bridge](https://github.com/anomalyco/browser-bridge) relay running on port 9223

## Quick Start

### 1. Start browser-bridge relay

```bash
cd browser-bridge
node relay.js
```

This connects to Chrome DevTools via CDP at `ws://localhost:9223`.

### 2. Start the proxy

```bash
cd chatgpt-proxy
npm start
```

Listens on `http://localhost:9225`.

### 3. Use it

```bash
curl http://localhost:9225/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "chatgpt-web",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

Or open `test/chatgpt-test.html` in a browser.

## Configuration

| Env var | Default | Description |
|---------|---------|-------------|
| `PORT` | `9225` | Proxy listen port |

## Cookie Refresh

Cookies are cached for 30 seconds. If a request fails with 401, restart the browser session and cookies will be re-fetched.
