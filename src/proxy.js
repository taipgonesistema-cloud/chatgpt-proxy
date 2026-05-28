import http from "node:http";
import https from "node:https";
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

const ROOT_PARENT_MESSAGE_ID = "client-created-root";
const convState = {
  conversation_id: null,
  parent_message_id: ROOT_PARENT_MESSAGE_ID,
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

function describeTool(tool) {
  const fn = tool?.function || tool || {};
  const params = fn.parameters || {};
  const props = params.properties || {};
  const required = Array.isArray(params.required) ? params.required : [];
  const args = Object.entries(props).map(([name, schema]) => {
    const req = required.includes(name) ? "required" : "optional";
    const type = schema?.type || "any";
    const desc = schema?.description ? ` - ${String(schema.description).slice(0, 80)}` : "";
    return `${name}: ${type} (${req})${desc}`;
  }).join(", ");
  const desc = fn.description ? `: ${String(fn.description).slice(0, 160)}` : "";
  return `- ${fn.name}${desc}\n  arguments: { ${args} }`;
}

function explicitlyRequestsTool(text) {
  return /\b(tool|ferramenta|bash|command|comando|run|rodar|execute|executar|pwd|read|ler|list|listar|grep|find|edit|editar|write|escrever)\b/i.test(String(text || ""));
}

function buildPrompt(params) {
  const messages = Array.isArray(params.messages) ? params.messages : [];
  const tools = Array.isArray(params.tools) ? params.tools : [];
  const parts = [PI_AGENT_CONTRACT];

  if (tools.length > 0) {
    parts.push([
      PI_TOOL_CONTRACT,
      "Available tools:",
      tools.map(describeTool).join("\n"),
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

  if (tools.length > 0 && explicitlyRequestsTool(lastUserText(messages))) {
    parts.push([
      "Tool-use enforcement:",
      "The latest user explicitly requested a tool/command/file operation.",
      "Your next response MUST be only one valid <tool_call>{...}</tool_call> wrapper.",
      "Do not answer from memory. Do not include explanation or final text before the tool result exists.",
      "For bash/pwd-style requests, call bash with the requested command.",
    ].join("\n"));
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

function httpsCall(method, path, headers, body, maxTime = 120000) {
  return new Promise((resolve, reject) => {
    const url = new URL(`https://chatgpt.com${path}`);
    if (body && !headers["Content-Type"]) {
      headers["Content-Type"] = "text/plain;charset=UTF-8";
    }
    const opts = { method, hostname: url.hostname, path: url.pathname, headers, timeout: maxTime };
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

function hasHeader(headers, name) {
  const needle = String(name).toLowerCase();
  return Object.keys(headers || {}).some((key) => key.toLowerCase() === needle);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function captureTokens(promptText) {
  const tabId = await getChatGptTabId();

  const startedAt = Date.now();
  await relay("/rewriteConversationStop").catch(() => {});
  const rewritePayload = JSON.stringify({ text: promptText, once: true, captureOnly: true });
  const rewrite = await relay(`/rewriteConversationStart?tabId=${tabId}`, rewritePayload, 10000, "application/json");
  if (!rewrite.result?.ok) throw new Error(rewrite.result?.error || "rewrite capture start failed");

  const code = `
(async()=>{
  const ta = document.getElementById('prompt-textarea');
  if(!ta) throw new Error('noprompt');
  ta.focus(); ta.textContent='';
  document.execCommand('insertText', false, '.');
  ta.dispatchEvent(new Event('input', {bubbles:true}));
  await new Promise(r=>setTimeout(r,300));
  const btn = document.querySelector('#composer-submit-button,[data-testid="send-button"]');
  if(!btn) throw new Error('nobutton');
  btn.click();
})()`;
  relay(`/evalAsync?tabId=${tabId}&timeout=30000`, code, 35000).catch(() => {});

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    await sleep(250);
    const status = await relay("/rewriteConversationStatus", null, 5000).catch(() => null);
    const history = status?.result?.history || [];
    const hit = [...history].reverse().find((item) =>
      item.captureOnly === true
      && item.timestamp >= startedAt
      && item.requestHeaders
      && item.rewrittenPostData
      && !item.rewriteError
    );
    if (!hit) continue;

    const capturedHeaders = hit.requestHeaders || {};
    if (!hasHeader(capturedHeaders, "authorization")) continue;

    log("tokens captured:",
      Object.keys(capturedHeaders).filter(k =>
        k.includes("sentinel") || k.includes("token") || k === "authorization"
      ).join(", ")
    );
    return { headers: capturedHeaders, body: hit.rewrittenPostData };
  }

  await relay("/rewriteConversationStop").catch(() => {});
  throw new Error("Token capture timed out");
}

async function triggerComposerPlaceholder(tabId) {
  const code = `
(async()=>{
  const ta = document.getElementById('prompt-textarea');
  if(!ta) throw new Error('noprompt');
  ta.focus(); ta.textContent='';
  document.execCommand('insertText', false, '.');
  ta.dispatchEvent(new Event('input', {bubbles:true}));
  await new Promise(r=>setTimeout(r,300));
  const btn = document.querySelector('#composer-submit-button,[data-testid="send-button"]');
  if(!btn) throw new Error('nobutton');
  btn.click();
})()`;
  await relay(`/evalAsync?tabId=${tabId}&timeout=30000`, code, 35000);
}

async function browserConversationViaBrowser(promptText) {
  const tabId = await getChatGptTabId();
  await relay(`/networkStart?tabId=${tabId}&filter=/backend-api/f/conversation`, null, 10000);

  const rewritePayload = JSON.stringify({ text: promptText, once: true, captureOnly: false });
  const rewrite = await relay(`/rewriteConversationStart?tabId=${tabId}`, rewritePayload, 10000, "application/json");
  if (!rewrite.result?.ok) throw new Error(rewrite.result?.error || "rewrite start failed");

  await triggerComposerPlaceholder(tabId);

  const deadline = Date.now() + 120000;
  let latestBody = "";
  while (Date.now() < deadline) {
    await sleep(500);
    const net = await relay("/networkResponses", null, 10000).catch(() => null);
    const responses = net?.result?.responses || [];
    const conv = [...responses].reverse().find((item) =>
      item.type === "Fetch"
      && String(item.url || "").includes("/backend-api/f/conversation")
      && !String(item.url || "").includes("/prepare")
      && typeof item.body === "string"
      && item.body.length > 0
    );
    if (conv?.body) latestBody = conv.body;
    if (latestBody.includes("message_stream_complete") || latestBody.includes("data: [DONE]")) {
      const sse = parseSSE(latestBody);
      if (sse.conversation_id) convState.conversation_id = sse.conversation_id;
      if (sse.assistant_id) {
        convState.parent_message_id = sse.assistant_id;
        convState.last_assistant_id = sse.assistant_id;
      }
      return sse.text;
    }
  }
  throw new Error(latestBody ? `Timed out after partial browser response: ${latestBody.slice(0, 500)}` : "Timed out waiting for browser response");
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

function parseSSE(text) {
  const textparts = [];
  let convId = null;
  let assistantId = null;
  let lastP = "";
  let lastO = "";
  for (const line of (text || "").split("\n")) {
    if (!line.startsWith("data: ")) continue;
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
  return { text: textparts.join(""), conversation_id: convId, assistant_id: assistantId };
}

async function browserConversation(promptText) {
  const { headers: capturedHeaders, body: newBody } = await captureTokens(promptText);

  const headers = { ...capturedHeaders };
  const blocked = new Set(["content-length", "host", "connection",
    "accept-encoding", "transfer-encoding"]);
  for (const h of blocked) delete headers[h];
  if (!hasHeader(headers, "accept")) headers["accept"] = "text/event-stream";

  const result = await httpsCall("POST", "/backend-api/f/conversation", headers, newBody);

  if (result.status !== 200) {
    throw new Error(`ChatGPT ${result.status}: ${result.text.slice(0, 500)}`);
  }

  const sse = parseSSE(result.text);

  if (sse.conversation_id) convState.conversation_id = sse.conversation_id;
  if (sse.assistant_id) {
    convState.parent_message_id = sse.assistant_id;
    convState.last_assistant_id = sse.assistant_id;
  }

  return sse.text;
}

async function browserConversationStream(promptText, res) {
  const { headers: capturedHeaders, body: newBody } = await captureTokens(promptText);

  const headers = { ...capturedHeaders };
  const blocked = new Set(["content-length", "host", "connection",
    "accept-encoding", "transfer-encoding"]);
  for (const h of blocked) delete headers[h];
  if (!hasHeader(headers, "accept")) headers["accept"] = "text/event-stream";

  const streamState = writeStreamStart(res);

  const url = new URL("https://chatgpt.com/backend-api/f/conversation");
  const opts = { method: "POST", hostname: url.hostname, path: url.pathname, headers, timeout: 120000 };

  await new Promise((resolve, reject) => {
    const req = https.request(opts, (chatRes) => {
      chatRes.setEncoding("utf8");
      let lastP = "", lastO = "", roleSent = false;

      chatRes.on("data", (chunk) => {
        for (const line of chunk.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          const payload = line.slice(6);
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

            if (curP === "/message/content/parts/0" && curO === "append") {
              const t = obj.v || "";
              if (t) writeStreamContent(res, streamState, t);
            }
            if (curO === "patch" && Array.isArray(obj.v)) {
              for (const op of obj.v) {
                if (op.p === "/message/content/parts/0" && op.o === "append") {
                  const t = op.v || "";
                  if (t) writeStreamContent(res, streamState, t);
                }
              }
            }
          } catch {}
        }
      });
      chatRes.on("end", () => {
        writeStreamDone(res, streamState);
        resolve();
      });
      chatRes.on("error", reject);
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.write(newBody);
    req.end();
  });
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
              const text = await browserConversationViaBrowser(prompt);
              const parsed = parseToolCalls(text);
              streamCompletion(res, text, parsed);
            } else {
              await browserConversationStream(prompt, res);
            }
            return;
          }
          const text = Array.isArray(params.tools) && params.tools.length > 0
            ? await browserConversationViaBrowser(prompt)
            : await browserConversation(prompt);
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
