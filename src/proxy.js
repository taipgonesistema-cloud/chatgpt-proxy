const http = require("http");
const https = require("https");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 9225);
const RELAY = "http://localhost:9223";

let requestQueue = Promise.resolve();
let cachedCookies = null;
let cachedCookieTime = 0;

let convState = {
  conversation_id: null,
  parent_message_id: "client-created-root",
  last_assistant_id: null,
};

function log(...args) { console.log("[chatgpt-proxy]", ...args); }

function json(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  });
  res.end(JSON.stringify(data));
}

function relay(path) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${RELAY}${path}`, { method: "GET" }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { data += c; });
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (err) { reject(new Error(`Relay err: ${err.message}\n${data.slice(0,200)}`)); }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

async function getCookieHeader() {
  if (cachedCookies && Date.now() - cachedCookieTime < 30000) return cachedCookies;
  const r = await relay("/cookies");
  const cookies = r?.result?.cookies || [];
  const domains = [".chatgpt.com", "chatgpt.com", ".auth.openai.com", "auth.openai.com"];
  const relevant = cookies.filter(c => domains.includes(c.domain));
  const header = relevant.map(c => `${c.name}=${c.value}`).join("; ");
  cachedCookies = header;
  cachedCookieTime = Date.now();
  return header;
}

async function getDeviceId() {
  const r = await relay("/cookies");
  const cookies = r?.result?.cookies || [];
  const did = cookies.find(c => c.name === "oai-did" && c.domain.includes("chatgpt"));
  return did ? did.value : "";
}

function httpsCall(method, path, headers, body, maxTime = 120000) {
  return new Promise((resolve, reject) => {
    const url = new URL(`https://chatgpt.com${path}`);
    if (body && !headers["Content-Type"]) {
      headers["Content-Type"] = "text/plain;charset=UTF-8";
    }
    const opts = { method, hostname: url.hostname, path: url.pathname, headers };
    const req = https.request(opts, (res) => {
      let data = "";
      res.setEncoding("utf8");
      const contentType = res.headers["content-type"] || "";
      if (contentType.includes("event-stream")) {
        let buffer = "";
        const timer = setTimeout(() => { res.destroy(); }, maxTime);
        res.on("data", chunk => {
          buffer += chunk;
          if (buffer.includes("[DONE]") || buffer.includes("message_stream_complete")) {
            clearTimeout(timer);
            res.destroy();
            resolve({ status: res.statusCode, headers: res.headers, text: buffer });
          }
        });
        res.on("close", () => {
          clearTimeout(timer);
          resolve({ status: res.statusCode, headers: res.headers, text: buffer });
        });
      } else {
        const timer = setTimeout(() => { req.destroy(); reject(new Error("Timeout")); }, maxTime);
        res.on("data", c => { data += c; });
        res.on("end", () => { clearTimeout(timer); resolve({ status: res.statusCode, headers: res.headers, text: data }); });
      }
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function parseSSE(text) {
  let textparts = [];
  let convId = null;
  let assistantId = null;
  let lastP = "";
  let lastO = "";
  for (const line of text.split("\n")) {
    if (line.startsWith("data: ")) {
      const p = line.slice(6);
      if (p === "[DONE]") continue;
      try {
        const obj = JSON.parse(p);
        if (obj.type === "resume_conversation_token" && obj.conversation_id) {
          convId = obj.conversation_id;
        }
        const curP = obj.p !== undefined ? obj.p : lastP;
        const curO = obj.o !== undefined ? obj.o : lastO;
        lastP = curP;
        lastO = curO;
        if (curP === "/message/content/parts/0" && curO === "append") {
          textparts.push(obj.v || "");
        }
        if (curO === "patch" && Array.isArray(obj.v)) {
          for (const op of obj.v) {
            if (op.p === "/message/content/parts/0" && op.o === "append") {
              textparts.push(op.v || "");
            }
          }
        }
        if (obj.v?.message?.author?.role === "assistant" && obj.v?.message?.id) {
          if (!assistantId) assistantId = obj.v.message.id;
        }
      } catch {}
    }
  }
  return { text: textparts.join(""), conversation_id: convId, assistant_id: assistantId };
}

async function sendMessage(prompt) {
  const cookie = await getCookieHeader();
  const deviceId = await getDeviceId();

  const baseHeaders = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148 Safari/537.36",
    "Origin": "https://chatgpt.com",
    "Referer": "https://chatgpt.com/",
    "Cookie": cookie,
  };

  if (deviceId) baseHeaders["oai-device-id"] = deviceId;

  // 1. sentinel
  const sResp = await httpsCall("POST", "/backend-api/sentinel/chat-requirements/prepare", {
    ...baseHeaders,
    "Content-Type": "text/plain;charset=UTF-8",
  }, "{}");
  if (sResp.status !== 200) throw new Error(`Sentinel ${sResp.status}: ${sResp.text.slice(0,200)}`);

  const sentinel = JSON.parse(sResp.text);
  const prepareToken = sentinel.prepare_token || sentinel.token || "";

  // 2. conv prepare
  const msgId = crypto.randomUUID();
  const prepareBody = JSON.stringify({
    action: "next",
    messages: [{
      id: msgId,
      author: { role: "user" },
      content: { content_type: "text", parts: [prompt] },
      metadata: {},
    }],
    parent_message_id: convState.parent_message_id,
    model: "auto",
    conversation_mode: { kind: "primary_assistant" },
    ...(convState.conversation_id ? { conversation_id: convState.conversation_id } : {}),
  });
  const cpResp = await httpsCall("POST", "/backend-api/f/conversation/prepare", {
    ...baseHeaders,
    "Content-Type": "application/json",
    "Openai-Sentinel-Chat-Requirements-Token": prepareToken,
  }, prepareBody);
  if (cpResp.status !== 200) throw new Error(`Conv prepare ${cpResp.status}: ${cpResp.text.slice(0,200)}`);

  const conduitToken = JSON.parse(cpResp.text).conduit_token || "";

  // 3. conversation
  const now = Date.now() / 1000;
  const convBody = JSON.stringify({
    action: "next",
    messages: [{
      id: msgId,
      author: { role: "user" },
      create_time: now,
      content: { content_type: "text", parts: [prompt] },
      metadata: {
        selected_github_repos: [],
        selected_all_github_repos: false,
        serialization_metadata: { custom_symbol_offsets: [] },
      },
    }],
    parent_message_id: convState.parent_message_id,
    model: "auto",
    client_prepare_state: "success",
    timezone_offset_min: 180,
    timezone: "America/Sao_Paulo",
    conversation_mode: { kind: "primary_assistant" },
    ...(convState.conversation_id ? { conversation_id: convState.conversation_id } : {}),
    enable_message_followups: true,
    system_hints: [],
    supports_buffering: true,
    supported_encodings: ["v1"],
    client_contextual_info: {
      is_dark_mode: true,
      time_since_loaded: 21,
      page_height: 935,
      page_width: 1920,
      pixel_ratio: 1,
      screen_height: 1080,
      screen_width: 1920,
      app_name: "chatgpt.com",
    },
    paragen_cot_summary_display_override: "allow",
    force_parallel_switch: "auto",
  });

  const conv = await httpsCall("POST", "/backend-api/f/conversation", {
    ...baseHeaders,
    "Openai-Sentinel-Chat-Requirements-Token": prepareToken,
    "Openai-Sentinel-Conduit-Token": conduitToken,
  }, convBody);

  if (conv.status !== 200) {
    throw new Error(`Conv ${conv.status}: ${conv.text.slice(0,800)}`);
  }

  const result = parseSSE(conv.text);

  if (result.conversation_id) convState.conversation_id = result.conversation_id;
  if (result.assistant_id) {
    convState.parent_message_id = result.assistant_id;
    convState.last_assistant_id = result.assistant_id;
  }

  return result.text || "No response";
}

http.createServer((req, res) => {
  if (req.method === "OPTIONS") return res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization" }), res.end();

  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    let body = "";
    req.on("data", c => { body += c; });
    req.on("end", () => {
      try {
        const p = JSON.parse(body);
        const lastUser = [...p.messages].reverse().find(m => m.role === "user");
        const prompt = lastUser ? lastUser.content : (p.messages[p.messages.length - 1]?.content || "");
        if (p.stream) return json(res, 400, { error: "Streaming not yet supported" });
        requestQueue = requestQueue.then(async () => {
          try {
            const text = await sendMessage(prompt);
            json(res, 200, {
              id: `chatcmpl-${Date.now()}`,
              object: "chat.completion",
              created: Math.floor(Date.now() / 1000),
              model: "chatgpt-web",
              choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
              usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
            });
          } catch (err) {
            log("ERROR:", err.message);
            json(res, 500, { error: err.message });
          }
        });
      } catch (err) {
        json(res, 400, { error: `Invalid JSON: ${err.message}` });
      }
    });
    return;
  }

  if (req.url === "/v1/models") {
    return json(res, 200, { object: "list", data: [{ id: "chatgpt-web", object: "model", created: Date.now(), owned_by: "openai" }] });
  }

  json(res, 404, { error: "Not found" });
}).listen(PORT, () => {
  log(`Running on http://localhost:${PORT}`);
});
