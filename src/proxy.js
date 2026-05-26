import http from 'http';
import https from 'https';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { registerFileTools, buildToolSystemPrompt } from './tools/index.js';
import { parseToolCallsFromContent, StreamingToolParser } from './tools/parser.js';
import { executeToolCalls, buildToolMessage, buildAssistantToolCallMessage } from './tools/executor.js';

// Register file tools at startup
registerFileTools();

process.on("uncaughtException", e => console.error("UNCAUGHT:", e));
process.on("unhandledRejection", e => console.error("UNHANDLED:", e));

const PORT = Number(process.env.PORT || 9225);
const RELAY = "http://localhost:9223";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

let cachedCookies = null;
let cachedCookieTime = 0;

const convState = {
  conversation_id: null,
  parent_message_id: "client-created-root",
  last_assistant_id: null,
};

function log(...args) { console.log("[chatgpt-proxy]", ...args); }

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS, PUT, DELETE",
    "Access-Control-Allow-Headers": "*",
  };
}

function json(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...corsHeaders() });
  res.end(JSON.stringify(data));
}

function relay(path) {
  log("relay GET", path);
  return new Promise((resolve, reject) => {
    const req = http.request(`${RELAY}${path}`, { method: "GET", timeout: 10000 }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { data += c; });
      res.on("end", () => {
        log("relay response", path, "status:", res.statusCode, "len:", data.length);
        try { resolve(JSON.parse(data)); }
        catch (err) { reject(new Error(`Relay err: ${err.message}\n${data.slice(0,200)}`)); }
      });
      res.on("error", (err) => { log("relay res error", path, err.message); reject(err); });
    });
    req.on("error", (err) => { log("relay req error", path, err.message); reject(err); });
    req.on("timeout", () => { log("relay timeout", path); req.destroy(); reject(new Error(`Relay timeout ${path}`)); });
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

function convertMessages(messages, tools) {
  const out = [];

  const sysHint = buildToolSystemPrompt();
  const clientSysHint = tools && tools.length > 0
    ? `\n\nThe client tool definitions:\n${tools.map(t => {
        const fn = t.function || t;
        return `- ${fn.name}: ${(fn.description || '').slice(0,200)}`;
      }).join('\n')}`
    : '';

  if (sysHint) {
    out.push({
      id: crypto.randomUUID(),
      author: { role: "system" },
      content: { content_type: "text", parts: [sysHint + clientSysHint] },
      metadata: {},
    });
  }

  for (const m of messages) {
    if (m.role === "system") {
      out.push({
        id: crypto.randomUUID(),
        author: { role: "system" },
        content: { content_type: "text", parts: [m.content] },
        metadata: {},
      });
    } else if (m.role === "user") {
      const parts = typeof m.content === "string" ? [m.content] : (m.content || []);
      out.push({
        id: crypto.randomUUID(),
        author: { role: "user" },
        content: { content_type: "text", parts },
        metadata: {},
      });
    } else if (m.role === "assistant") {
      let text = m.content || "";
      if (m.tool_calls) {
        text += (text ? "\n" : "") + m.tool_calls.map(tc =>
          `<tool_call>${JSON.stringify({ name: tc.function.name, arguments: JSON.parse(tc.function.arguments || '{}') })}</tool_call>`
        ).join("\n");
      }
      out.push({
        id: crypto.randomUUID(),
        author: { role: "assistant" },
        content: { content_type: "text", parts: [text] },
        metadata: {},
      });
    } else if (m.role === "tool") {
      const text = `[Tool result for ${m.tool_call_id}]:\n${m.content}`;
      out.push({
        id: crypto.randomUUID(),
        author: { role: "system" },
        content: { content_type: "text", parts: [text] },
        metadata: {},
      });
    }
  }
  return out;
}

async function sendMessage(messages, tools) {
  const cookie = await getCookieHeader();
  const deviceId = await getDeviceId();

  const baseHeaders = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148 Safari/537.36",
    "Origin": "https://chatgpt.com",
    "Referer": "https://chatgpt.com/",
    "Cookie": cookie,
  };

  if (deviceId) baseHeaders["oai-device-id"] = deviceId;

  const sResp = await httpsCall("POST", "/backend-api/sentinel/chat-requirements/prepare", {
    ...baseHeaders,
    "Content-Type": "text/plain;charset=UTF-8",
  }, "{}");
  if (sResp.status !== 200) throw new Error(`Sentinel ${sResp.status}: ${sResp.text.slice(0,200)}`);

  const sentinel = JSON.parse(sResp.text);
  const prepareToken = sentinel.prepare_token || sentinel.token || "";

  const msgs = convertMessages(messages, tools);

  const prepareBody = JSON.stringify({
    action: "next",
    messages: msgs,
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

  const now = Date.now() / 1000;
  const convMsgs = msgs.map(m => ({
    ...m,
    create_time: now,
    metadata: {
      ...m.metadata,
      selected_github_repos: [],
      selected_all_github_repos: false,
      serialization_metadata: { custom_symbol_offsets: [] },
    },
  }));
  const convBody = JSON.stringify({
    action: "next",
    messages: convMsgs,
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

  const text = result.text || "";

  const parsed = parseToolCallsFromContent(text);
  if (parsed.toolCalls.length > 0) {
    return {
      type: "tool_calls",
      tool_calls: parsed.toolCalls.map(tc => ({
        id: tc.id,
        type: "function",
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
      })),
      text: parsed.textContent,
    };
  }

  return { type: "text", text };
}

// Strip <tool_call>...</tool_call> from text for clean client display
function stripToolCalls(text) {
  return text.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '');
}

function sendSSEChunk(res, id, created, delta, finishReason) {
  const chunk = {
    id, object: "chat.completion.chunk", created, model: "chatgpt-web",
    choices: [{ index: 0, delta, finish_reason: finishReason || null }],
  };
  res.write(`data: ${JSON.stringify(chunk)}\n\n`);
}

function looksLikeToolRequest(messages) {
  const lastUser = [...messages].reverse().find(m => m.role === "user")?.content || "";
  return /cria|criar|create|write|escrev|edita|edit|delete|remove|pasta|folder|file|arquivo|roda|run|command|mkdir|leia|read|lista|list|dir/i.test(String(lastUser));
}

// ===== HTTP SERVER =====

http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/") {
    const filePath = path.join(__dirname, "..", "..", "index.html");
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, "utf8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(content);
    }
    return res.writeHead(404), res.end("index.html not found");
  }

  if (req.method === "OPTIONS") return res.writeHead(204, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS, PUT, DELETE",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Max-Age": "86400",
  }), res.end();

  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    log("INCOMING from:", req.socket.remoteAddress || "unknown");
    let body = "";
    req.on("data", c => { body += c; });
    req.on("end", async () => {
      log("req body len:", body.length);
      try {
        const p = JSON.parse(body);
        if (p.messages && p.messages.length > 10) {
          p.messages = p.messages.filter(m => m.role === "system").concat(p.messages.filter(m => m.role !== "system").slice(-10));
        }
        try {
          if (p.stream) {
            log("starting stream handler");
            await handleStreamWithTimeout(p, res);
            log("stream handler done");
            return;
          }

          log("calling sendMessage");
          const result = await sendMessage(p.messages || [], p.tools);

          if (result.type === "tool_calls") {
            log("tool calls detected, running server-side execution");
            const toolCalls = result.tool_calls.map(tc => ({
              id: tc.id,
              name: tc.function.name,
              arguments: typeof tc.function.arguments === 'string'
                ? JSON.parse(tc.function.arguments)
                : tc.function.arguments,
            }));

            const context = { messages: p.messages, turn: 0, model: p.model };
            const toolResults = await executeToolCalls(toolCalls, context);

            const msgs = [...p.messages];
            msgs.push({ role: "assistant", content: result.text || null, tool_calls: result.tool_calls });
            for (const tr of toolResults) {
              msgs.push(buildToolMessage(tr));
            }

            const nextResult = await sendMessage(msgs, p.tools);

            if (nextResult.type === "tool_calls") {
              json(res, 200, {
                id: `chatcmpl-${Date.now()}`,
                object: "chat.completion",
                created: Math.floor(Date.now() / 1000),
                model: "chatgpt-web",
                choices: [{ index: 0, message: { role: "assistant", content: null, tool_calls: nextResult.tool_calls }, finish_reason: "tool_calls" }],
                usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
              });
            } else {
              json(res, 200, {
                id: `chatcmpl-${Date.now()}`,
                object: "chat.completion",
                created: Math.floor(Date.now() / 1000),
                model: "chatgpt-web",
                choices: [{ index: 0, message: { role: "assistant", content: nextResult.text }, finish_reason: "stop" }],
                usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
              });
            }
          } else {
            json(res, 200, {
              id: `chatcmpl-${Date.now()}`,
              object: "chat.completion",
              created: Math.floor(Date.now() / 1000),
              model: "chatgpt-web",
              choices: [{ index: 0, message: { role: "assistant", content: result.text }, finish_reason: "stop" }],
              usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
            });
          }
        } catch (err) {
          log("ERROR:", err.message);
          json(res, 500, { error: err.message });
        }
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

// ===== STREAMING WITH SERVER-SIDE TOOL LOOP =====

async function handleStream(p, res) {
  const cookie = await getCookieHeader();
  const deviceId = await getDeviceId();
  const baseHeaders = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148 Safari/537.36",
    "Origin": "https://chatgpt.com",
    "Referer": "https://chatgpt.com/",
    "Cookie": cookie,
  };
  if (deviceId) baseHeaders["oai-device-id"] = deviceId;

  const sResp = await httpsCall("POST", "/backend-api/sentinel/chat-requirements/prepare", { ...baseHeaders, "Content-Type": "text/plain;charset=UTF-8" }, "{}");
  if (sResp.status !== 200) return json(res, 500, { error: `Sentinel ${sResp.status}` });
  const prepareToken = (JSON.parse(sResp.text).prepare_token || "");

  const loopMessages = [...(p.messages || [])];

  const id = `chatcmpl-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const shouldForceTool = looksLikeToolRequest(loopMessages);
  let executedToolCount = 0;
  let retryWithoutToolCount = 0;

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    ...corsHeaders(),
  });

  const maxTurns = 10;
  for (let turn = 0; turn < maxTurns; turn++) {
    log(`stream turn ${turn + 1}/${maxTurns}`);
    const msgs = convertMessages(loopMessages, p.tools);

    const prepareBody = JSON.stringify({
      action: "next", messages: msgs, parent_message_id: convState.parent_message_id,
      model: "auto", conversation_mode: { kind: "primary_assistant" },
      ...(convState.conversation_id ? { conversation_id: convState.conversation_id } : {}),
    });
    const cpResp = await httpsCall("POST", "/backend-api/f/conversation/prepare", { ...baseHeaders, "Content-Type": "application/json", "Openai-Sentinel-Chat-Requirements-Token": prepareToken }, prepareBody);
    if (cpResp.status !== 200) {
      if (turn === 0) return json(res, 500, { error: `Conv prepare ${cpResp.status}` });
      break;
    }
    const conduitToken = JSON.parse(cpResp.text).conduit_token || "";

    const nowTs = Date.now() / 1000;
    const convMsgs = msgs.map(m => ({ ...m, create_time: nowTs, metadata: { ...m.metadata, selected_github_repos: [], selected_all_github_repos: false, serialization_metadata: { custom_symbol_offsets: [] } } }));
    const convBody = JSON.stringify({
      action: "next", messages: convMsgs, parent_message_id: convState.parent_message_id,
      model: "auto", client_prepare_state: "success", timezone_offset_min: 180,
      timezone: "America/Sao_Paulo", conversation_mode: { kind: "primary_assistant" },
      ...(convState.conversation_id ? { conversation_id: convState.conversation_id } : {}),
      enable_message_followups: true, system_hints: [], supports_buffering: true,
      supported_encodings: ["v1"],
      client_contextual_info: { is_dark_mode: true, time_since_loaded: 21, page_height: 935, page_width: 1920, pixel_ratio: 1, screen_height: 1080, screen_width: 1920, app_name: "chatgpt.com" },
      paragen_cot_summary_display_override: "allow", force_parallel_switch: "auto",
    });

    let sseBuffer = "", lastP = "", lastO = "", roleSentInTurn = false, collectedText = "";
    const toolStreamParser = new StreamingToolParser();

    const emitCleanText = (clean) => {
      if (!clean) return;
      if (!roleSentInTurn) {
        sendSSEChunk(res, id, created, { role: "assistant", content: clean }, null);
        roleSentInTurn = true;
      } else {
        sendSSEChunk(res, id, created, { content: clean }, null);
      }
    };

    await new Promise((resolve, reject) => {
      const convReq = https.request(new URL("https://chatgpt.com/backend-api/f/conversation"), {
        method: "POST",
        headers: { ...baseHeaders, "Openai-Sentinel-Chat-Requirements-Token": prepareToken, "Openai-Sentinel-Conduit-Token": conduitToken },
      }, (convRes) => {
        convRes.setEncoding("utf8");
        convRes.on("data", (chunk) => {
          sseBuffer += chunk;
          const parts = sseBuffer.split(/\n\n/);
          sseBuffer = parts.pop() || "";

          for (const part of parts) {
            const dataMatch = part.match(/^data: (.+)/m);
            if (!dataMatch) continue;
            const payload = dataMatch[1];
            if (payload === "[DONE]") continue;

            try {
              const obj = JSON.parse(payload);
              if (typeof obj !== "object") continue;

              if (obj.type === "resume_conversation_token" && obj.conversation_id) {
                convState.conversation_id = obj.conversation_id;
              }
              if (obj.v?.message?.author?.role === "assistant" && obj.v?.message?.id) {
                convState.parent_message_id = obj.v.message.id;
                convState.last_assistant_id = obj.v.message.id;
              }

              const curP = obj.p !== undefined ? obj.p : lastP;
              const curO = obj.o !== undefined ? obj.o : lastO;
              lastP = curP; lastO = curO;

              // Helper to stream a clean text chunk (tool calls stripped)
              const streamText = (t) => {
                collectedText += t;
                const parsedChunk = toolStreamParser.feed(t);
                emitCleanText(parsedChunk.text);
              };

              if (curP === "/message/content/parts/0" && curO === "append") {
                const t = obj.v || "";
                if (t) streamText(t);
              }

              if (curO === "patch" && Array.isArray(obj.v)) {
                for (const op of obj.v) {
                  if (op.p === "/message/content/parts/0" && op.o === "append") {
                    const t = op.v || "";
                    if (t) streamText(t);
                  }
                }
              }
            } catch {}
          }
        });
        convRes.on("end", () => {
          const finalChunk = toolStreamParser.flush();
          emitCleanText(finalChunk.text);
          if (!roleSentInTurn && !collectedText) {
            sendSSEChunk(res, id, created, { role: "assistant", content: "" }, null);
          }
          resolve();
        });
        convRes.on("error", reject);
      });
      convReq.on("error", reject);
      convReq.write(convBody);
      convReq.end();
    });

    // Parse for tool calls
    const parsed = parseToolCallsFromContent(collectedText);

    if (parsed.toolCalls.length === 0) {
      if (shouldForceTool && executedToolCount === 0 && retryWithoutToolCount < 2) {
        retryWithoutToolCount++;
        loopMessages.push({ role: "assistant", content: collectedText || "" });
        loopMessages.push({
          role: "user",
          content: "You did not call a tool. The requested operation will not happen unless you call a tool. Respond ONLY with the correct <tool_call>{\"name\":\"...\",\"arguments\":{...}}</tool_call> now.",
        });
        log(`turn ${turn + 1}: no tool call for tool request, retrying (${retryWithoutToolCount}/2)`);
        continue;
      }
      sendSSEChunk(res, id, created, {}, "stop");
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    log(`turn ${turn + 1}: ${parsed.toolCalls.length} tool calls, executing server-side...`);

    const toolCallsForMsg = parsed.toolCalls.map(tc => ({
      id: tc.id,
      type: "function",
      function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
    }));

    loopMessages.push({ role: "assistant", content: parsed.textContent || null, tool_calls: toolCallsForMsg });

    const context = { messages: loopMessages, turn, model: "chatgpt-web" };
    const toolResults = await executeToolCalls(parsed.toolCalls, context);
    executedToolCount += parsed.toolCalls.length;

    for (const tr of toolResults) {
      loopMessages.push(buildToolMessage(tr));
    }

    log(`turn ${turn + 1}: tools executed (${toolResults.filter(r => r.isError).length} errors)`);

    if (turn >= maxTurns - 1) {
      sendSSEChunk(res, id, created, {}, "tool_calls");
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
  }

  sendSSEChunk(res, id, created, {}, "stop");
  res.write("data: [DONE]\n\n");
  res.end();
}

async function handleStreamWithTimeout(p, res) {
  const timer = setTimeout(() => {
    log("STREAM TIMEOUT");
    try { res.write("data: [DONE]\n\n"); res.end(); } catch {}
  }, 120000);
  try { await handleStream(p, res); }
  finally { clearTimeout(timer); }
}
