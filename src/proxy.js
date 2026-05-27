import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";

const PORT = Number(process.env.PORT || 9225);
const RELAY = "http://localhost:9223";
const UI_PATH = "C:\\Users\\Desktop\\Desktop\\yk\\index.html";
const PI_AGENT_CONTRACT = [
  "You are a precise, pragmatic software engineering agent running inside Pi Coding Agent.",
  "Your priorities are correctness, evidence, minimal safe changes, and clear concise communication.",
  "Do not guess about files, APIs, commands, package scripts, config, errors, or project structure. Inspect with tools first.",
  "Before answering questions about the current workspace, use read/list/search tools unless the answer is already present in the conversation.",
  "Before editing code, inspect the relevant files and understand the existing style. Make the smallest correct change.",
  "Never claim you changed, tested, installed, ran, or verified something unless a tool result proves it.",
  "If a command fails, use the error output to diagnose and continue with a smaller next step when safe.",
  "Do not overwrite or revert user work unless explicitly asked. Treat unexpected file changes as user-owned.",
  "Avoid broad refactors, new abstractions, and compatibility layers unless the user asks or the existing code clearly requires them.",
  "Prefer concrete file paths, command names, and observed outputs over general explanations.",
  "When implementation is requested, act instead of only proposing. When the user asks a question, answer directly after gathering enough evidence.",
  "For code review, prioritize bugs, regressions, missing tests, and risks before summaries.",
  "For frontend work, preserve the existing design system unless the user asks for redesign.",
  "Security: do not expose secrets, tokens, cookies, private keys, or credential files. Do not print sensitive file contents unless explicitly required and safe.",
  "Use Portuguese when the user writes Portuguese. Keep final answers concise and factual.",
].join("\n");
const PI_TOOL_CONTRACT = [
  "You are running inside Pi Coding Agent through an OpenAI-compatible proxy.",
  "Pi can execute tools for you, but only if your response is valid structured tool-call text.",
  "When a tool is needed, output only tool calls and nothing else.",
  "Use exactly this form, with valid JSON inside:",
  '<tool_call>{"name":"tool_name","arguments":{"arg":"value"}}</tool_call>',
  "Never put tool calls in Markdown code fences.",
  "Never explain a tool call before or after emitting it.",
  "The arguments object must match the selected tool schema exactly.",
  "For bash, command and timeout are separate fields, for example:",
  '<tool_call>{"name":"bash","arguments":{"command":"dir","timeout":10}}</tool_call>',
  "Do not produce malformed JSON like {\"command\":\"timeout\":10}.",
  "After Pi returns tool results in later messages, use those results to answer concisely.",
  "Use Portuguese when the user writes Portuguese, unless the task requires code or exact command output.",
].join("\n");

let requestQueue = Promise.resolve();
let tabId = null;

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

function relay(path, body = null, timeoutMs = 60000, contentType = "text/plain;charset=UTF-8") {
  return new Promise((resolve, reject) => {
    const url = new URL(RELAY + path);
    const opts = {
      method: body === null ? "GET" : "POST",
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      timeout: timeoutMs,
    };
    if (body !== null) opts.headers = { "Content-Type": contentType, "Content-Length": Buffer.byteLength(body) };
    const req = http.request(opts, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c) => data += c);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (err) { reject(new Error(`Relay parse: ${err.message}: ${data.slice(0, 200)}`)); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Relay timeout")); });
    if (body !== null) req.write(body);
    req.end();
  });
}

async function getChatGptTabId() {
  if (tabId) return tabId;
  const r = await relay("/tabs", null, 10000);
  const tabs = r?.result || [];
  const tab = tabs.find((t) => t.url?.startsWith("https://chatgpt.com"));
  if (!tab) throw new Error("No ChatGPT tab found");
  tabId = tab.id;
  return tab.id;
}

async function evalInTab(code, timeoutMs = 30000) {
  const id = await getChatGptTabId();
  const r = await relay(`/evalAsync?tabId=${id}&timeout=${timeoutMs}`, code, timeoutMs + 5000);
  if (!r.result?.ok) throw new Error(r.result?.error || "eval failed");
  return r.result.result;
}

function lastUserText(messages) {
  const last = [...(messages || [])].reverse().find((m) => m.role === "user");
  if (!last) return "";
  if (typeof last.content === "string") return last.content;
  if (Array.isArray(last.content)) {
    return last.content.map((p) => typeof p === "string" ? p : p?.text || "").filter(Boolean).join("\n");
  }
  return String(last.content || "");
}

function messageContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === "string") return part;
      if (part?.type === "text") return part.text || "";
      return part?.text || JSON.stringify(part);
    }).filter(Boolean).join("\n");
  }
  return content == null ? "" : String(content);
}

function buildPrompt(params) {
  const messages = Array.isArray(params.messages) ? params.messages : [];
  const tools = Array.isArray(params.tools) ? params.tools : [];
  const parts = [PI_AGENT_CONTRACT];

  if (tools.length > 0) {
    parts.push([
      PI_TOOL_CONTRACT,
      "Available tools:",
      JSON.stringify(tools, null, 2),
    ].join("\n"));
  }

  for (const message of messages) {
    const role = message?.role || "user";
    if (role === "assistant" && Array.isArray(message.tool_calls)) {
      parts.push(`assistant tool calls:\n${JSON.stringify(message.tool_calls, null, 2)}`);
      continue;
    }
    const name = message?.name ? ` ${message.name}` : "";
    const content = messageContent(message?.content);
    if (!content && role !== "tool") continue;
    parts.push(`${role}${name}:\n${content}`);
  }

  return parts.join("\n\n").trim() || lastUserText(messages);
}

function parseToolCalls(text) {
  const calls = [];
  let remaining = text || "";
  const parts = [];
  while (true) {
    const start = remaining.indexOf("<tool_call>");
    if (start === -1) { parts.push(remaining); break; }
    parts.push(remaining.slice(0, start));
    const end = remaining.indexOf("</tool_call>", start + 11);
    if (end === -1) { parts.push(remaining.slice(start)); break; }
    const raw = remaining.slice(start + 11, end).trim();
    try {
      const parsed = JSON.parse(raw);
      calls.push({
        id: "call_" + crypto.randomUUID().replace(/-/g, "").slice(0, 16),
        type: "function",
        function: {
          name: parsed.name || "",
          arguments: typeof parsed.arguments === "string" ? parsed.arguments : JSON.stringify(parsed.arguments || {}),
        },
      });
    } catch {
      parts.push(`<tool_call>${raw}</tool_call>`);
    }
    remaining = remaining.slice(end + 12);
  }
  return { textContent: parts.join("").trim(), toolCalls: calls };
}

function appendFromEncodedItem(encoded) {
  let out = "";
  for (const line of String(encoded || "").split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const data = line.slice(6);
    if (!data || data === "[DONE]" || data.startsWith('"')) continue;
    try {
      const obj = JSON.parse(data);
      if (obj.p === "/message/content/parts/0" && obj.o === "append") out += obj.v || "";
      if (!obj.p && typeof obj.v === "string") out += obj.v;
      if (obj.o === "patch" && Array.isArray(obj.v)) {
        for (const op of obj.v) {
          if (op.p === "/message/content/parts/0" && op.o === "append") out += op.v || "";
        }
      }
    } catch {}
  }
  return out;
}

function collectEncodedItems(value, out = []) {
  if (!value || typeof value !== "object") return out;
  if (typeof value.encoded_item === "string") {
    out.push({ id: value.stream_item_id || null, encoded: value.encoded_item });
  }
  if (Array.isArray(value)) {
    for (const item of value) collectEncodedItems(item, out);
  } else {
    for (const item of Object.values(value)) collectEncodedItems(item, out);
  }
  return out;
}

function parseNetworkText(responses) {
  let text = "";
  const seen = new Set();
  for (const item of responses || []) {
    if (item.type !== "WebSocket" || item.event !== "frameReceived" || !item.data) continue;
    try {
      const frames = JSON.parse(item.data);
      for (const encodedItem of collectEncodedItems(frames)) {
        const key = `${encodedItem.id || ""}:${encodedItem.encoded}`;
        if (seen.has(key)) continue;
        seen.add(key);
        text += appendFromEncodedItem(encodedItem.encoded);
      }
    } catch {}
  }
  return text;
}

function nextNetworkChunks(responses, seen) {
  const chunks = [];
  for (const item of responses || []) {
    if (item.type !== "WebSocket" || item.event !== "frameReceived" || !item.data) continue;
    try {
      const frames = JSON.parse(item.data);
      for (const encodedItem of collectEncodedItems(frames)) {
        const key = `${encodedItem.id || ""}:${encodedItem.encoded}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const text = appendFromEncodedItem(encodedItem.encoded);
        if (text) chunks.push(text);
      }
    } catch {}
  }
  return chunks;
}

function streamJson(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function streamCompletion(res, text, parsed) {
  const id = `chatcmpl-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });
  streamJson(res, {
    id,
    object: "chat.completion.chunk",
    created,
    model: "chatgpt-web",
    choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
  });
  if (parsed.toolCalls.length > 0) {
    parsed.toolCalls.forEach((call, index) => {
      streamJson(res, {
        id,
        object: "chat.completion.chunk",
        created,
        model: "chatgpt-web",
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index,
              id: call.id,
              type: call.type,
              function: call.function,
            }],
          },
          finish_reason: null,
        }],
      });
    });
  } else if (parsed.textContent) {
    streamJson(res, {
      id,
      object: "chat.completion.chunk",
      created,
      model: "chatgpt-web",
      choices: [{ index: 0, delta: { content: parsed.textContent }, finish_reason: null }],
    });
  }
  streamJson(res, {
    id,
    object: "chat.completion.chunk",
    created,
    model: "chatgpt-web",
    choices: [{ index: 0, delta: {}, finish_reason: parsed.toolCalls.length > 0 ? "tool_calls" : "stop" }],
  });
  res.write("data: [DONE]\n\n");
  res.end();
}

function writeStreamStart(res) {
  const id = `chatcmpl-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });
  streamJson(res, {
    id,
    object: "chat.completion.chunk",
    created,
    model: "chatgpt-web",
    choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
  });
  return { id, created };
}

function writeStreamContent(res, streamState, content) {
  streamJson(res, {
    id: streamState.id,
    object: "chat.completion.chunk",
    created: streamState.created,
    model: "chatgpt-web",
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  });
}

function writeStreamDone(res, streamState, finishReason = "stop") {
  streamJson(res, {
    id: streamState.id,
    object: "chat.completion.chunk",
    created: streamState.created,
    model: "chatgpt-web",
    choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
  });
  res.write("data: [DONE]\n\n");
  res.end();
}

async function triggerComposerSend() {
  const code = `
(async () => {
  const input = document.getElementById('prompt-textarea');
  if (!input) return JSON.stringify({ok:false,error:'no prompt-textarea'});
  input.focus();
  input.textContent = '';
  document.execCommand('insertText', false, '.');
  input.dispatchEvent(new Event('input', {bubbles:true}));
  await new Promise(r => setTimeout(r, 250));
  const button = document.querySelector('#composer-submit-button,[data-testid="send-button"]');
  if (!button) return JSON.stringify({ok:false,error:'no send button'});
  button.click();
  return JSON.stringify({ok:true});
})()`;
  const raw = await evalInTab(code, 20000);
  const result = JSON.parse(raw);
  if (!result.ok) throw new Error(result.error || "send trigger failed");
}

async function browserConversation(promptText) {
  const id = await getChatGptTabId();
  await relay(`/networkStart?tabId=${id}&filter=/backend-api/f/conversation`, null, 10000);

  const rewritePayload = JSON.stringify({ text: promptText, once: true });
  const rewrite = await relay(`/rewriteConversationStart?tabId=${id}`, rewritePayload, 10000, "application/json");
  if (!rewrite.result?.ok) throw new Error(rewrite.result?.error || "rewrite start failed");

  await triggerComposerSend();

  const deadline = Date.now() + 120000;
  let latestText = "";
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    const net = await relay("/networkResponses", null, 10000);
    const responses = net.result?.responses || [];
    latestText = parseNetworkText(responses) || latestText;
    const complete = responses.some((item) => item.type === "WebSocket" && item.event === "frameReceived" && String(item.data || "").includes("message_stream_complete"));
    if (complete && latestText) return latestText;
  }
  throw new Error(latestText ? `Timed out after partial response: ${latestText}` : "Timed out waiting for ChatGPT response");
}

async function browserConversationStream(promptText, res) {
  const streamState = writeStreamStart(res);
  const id = await getChatGptTabId();
  await relay(`/networkStart?tabId=${id}&filter=/backend-api/f/conversation`, null, 10000);

  const rewritePayload = JSON.stringify({ text: promptText, once: true });
  const rewrite = await relay(`/rewriteConversationStart?tabId=${id}`, rewritePayload, 10000, "application/json");
  if (!rewrite.result?.ok) throw new Error(rewrite.result?.error || "rewrite start failed");

  await triggerComposerSend();

  const seen = new Set();
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300));
    const net = await relay("/networkResponses", null, 10000);
    const responses = net.result?.responses || [];
    for (const chunk of nextNetworkChunks(responses, seen)) {
      writeStreamContent(res, streamState, chunk);
    }
    const complete = responses.some((item) => item.type === "WebSocket" && item.event === "frameReceived" && String(item.data || "").includes("message_stream_complete"));
    if (complete) {
      writeStreamDone(res, streamState);
      return;
    }
  }
  writeStreamDone(res, streamState, "stop");
}

http.createServer((req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization" });
    res.end();
    return;
  }

  if (req.method === "POST" && (req.url === "/v1/chat/completions" || req.url === "/v1/chat/completions-stream")) {
    let body = "";
    req.on("data", (c) => body += c);
    req.on("end", () => {
      let params;
      try { params = JSON.parse(body); }
      catch (err) { json(res, 400, { error: `Invalid JSON: ${err.message}` }); return; }

      requestQueue = requestQueue.then(async () => {
        try {
          const prompt = buildPrompt(params);
          if (!prompt) throw new Error("No user message");
          log("Sending via CDP rewrite...");
          if (params.stream) {
            if (Array.isArray(params.tools) && params.tools.length > 0) {
              const text = await browserConversation(prompt);
              const parsed = parseToolCalls(text);
              streamCompletion(res, text, parsed);
            } else {
              await browserConversationStream(prompt, res);
            }
            return;
          }
          const text = await browserConversation(prompt);
          const parsed = parseToolCalls(text);
          json(res, 200, {
            id: `chatcmpl-${Date.now()}`,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: "chatgpt-web",
            choices: [{
              index: 0,
              message: parsed.toolCalls.length > 0
                ? { role: "assistant", content: null, tool_calls: parsed.toolCalls }
                : { role: "assistant", content: parsed.textContent },
              finish_reason: parsed.toolCalls.length > 0 ? "tool_calls" : "stop",
            }],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          });
        } catch (err) {
          log("ERROR:", err.message);
          if (!res.headersSent) json(res, 500, { error: err.message });
          else {
            res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
            res.write("data: [DONE]\n\n");
            res.end();
          }
        }
      });
    });
    return;
  }

  if (req.method === "POST" && req.url === "/api/session/new") {
    json(res, 200, { ok: true });
    return;
  }

  if (req.url === "/v1/models") {
    json(res, 200, { object: "list", data: [{ id: "chatgpt-web", object: "model", created: Date.now(), owned_by: "openai" }] });
    return;
  }

  if ((req.method === "GET" || req.method === "HEAD") && (req.url === "/" || req.url === "/index.html")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    if (req.method === "HEAD") { res.end(); return; }
    res.end(fs.readFileSync(UI_PATH, "utf8"));
    return;
  }

  json(res, 404, { error: "Not found" });
}).listen(PORT, () => {
  log(`Running on http://localhost:${PORT}`);
});
