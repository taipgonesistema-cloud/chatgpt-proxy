import http from "node:http";
import https from "node:https";
import crypto from "node:crypto";
import fs from "node:fs";

const PORT = Number(process.env.PORT || 9225);
const RELAY = (process.env.BROWSER_BACKEND_URL || process.env.BROWSER_RELAY_URL || "http://localhost:9223").replace(/\/+$/, "");
const PROXY_API_KEY = process.env.PROXY_API_KEY || "";
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
  "Do not answer the result of a command or file operation yourself; that result only exists after Pi executes the tool.",
  "Prefer small, verifiable tool calls over one huge shell command.",
  "For multi-file work, create directories, write one or a few files, then verify with a listing command.",
  "When creating files, verify that required files are non-empty and contain the expected kind of content, not only that paths exist.",
  "Avoid long bash heredocs when possible; malformed heredocs break execution.",
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
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key",
  });
  res.end(JSON.stringify(data));
}

function isAuthorized(req) {
  if (!PROXY_API_KEY) return true;
  const auth = Array.isArray(req.headers.authorization) ? req.headers.authorization[0] : req.headers.authorization;
  const apiKey = Array.isArray(req.headers["x-api-key"]) ? req.headers["x-api-key"][0] : req.headers["x-api-key"];
  return auth === `Bearer ${PROXY_API_KEY}` || apiKey === PROXY_API_KEY;
}

function unauthorized(res) {
  json(res, 401, { error: "Unauthorized" });
}

function v1Info() {
  return {
    object: "api.compat",
    compatible_with: "openai-chat-completions",
    base_url: `http://localhost:${PORT}/v1`,
    models_url: "/v1/models",
    chat_completions_url: "/v1/chat/completions",
    model: "chatgpt-web",
    streaming: true,
    auth: PROXY_API_KEY ? "bearer" : "none",
  };
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
  let tab = tabs.find((t) => t.url?.startsWith("https://chatgpt.com"));
  if (!tab && process.env.CHATGPT_AUTO_OPEN !== "0") {
    const opened = await relay(`/newTab?url=${encodeURIComponent("https://chatgpt.com/")}`, null, 30000).catch(() => null);
    if (opened?.result?.id) tab = { id: opened.result.id, url: opened.result.url };
    if (!tab) {
      await sleep(1000);
      const retry = await relay("/tabs", null, 10000);
      tab = (retry?.result || []).find((t) => t.url?.startsWith("https://chatgpt.com"));
    }
  }
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

function hasToolResult(messages) {
  return (messages || []).some((m) => m?.role === "tool" || m?.role === "toolResult");
}

function implementationTaskRequested(text) {
  return /\b(create|criar|crie|write|escrever|editar|edit|mkdir|pasta|folder|arquivo|file|landing|page|implementar|implement|corrigir|fix|gerar|generate)\b/i.test(String(text || ""));
}

function canContinueAfterToolResult(params) {
  return implementationTaskRequested(lastUserText(Array.isArray(params?.messages) ? params.messages : []));
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

function requestedBashCommand(text) {
  const value = String(text || "").trim();
  if (!/\bbash\b|\b(command|comando|run|rodar|execute|executar)\b/i.test(value)) return "";
  const patterns = [
    /\b(?:bash\s+)?(?:para\s+)?(?:rodar|executar|execute|run)\s*:\s*(.+?)(?:\s+e\s+(?:responda|retorne|me diga)|\s+and\s+(?:respond|return|tell)|$)/i,
    /\b(?:bash\s+)?(?:para\s+)?(?:rodar|executar|execute|run)\s+`([^`]+)`/i,
    /\b(?:bash\s+)?(?:para\s+)?(?:rodar|executar|execute|run)\s+"([^"]+)"/i,
    /\b(?:bash\s+)?(?:para\s+)?(?:rodar|executar|execute|run)\s+(.+?)(?:\s+e\s+(?:responda|retorne|me diga)|\s+and\s+(?:respond|return|tell)|$)/i,
  ];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    const command = match?.[1]?.trim().replace(/[.!?]+$/, "");
    if (command) return command;
  }
  return "";
}

function toolCallRequired(params) {
  const messages = Array.isArray(params?.messages) ? params.messages : [];
  return Array.isArray(params?.tools)
    && params.tools.length > 0
    && explicitlyRequestsTool(lastUserText(messages))
    && !hasToolResult(messages);
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

  if (tools.length > 0 && hasToolResult(messages)) {
    const canContinue = canContinueAfterToolResult(params);
    parts.push([
      "Tool result handling:",
      "A tool result is already present in the conversation.",
      canContinue
        ? "If the user's requested file/code task is incomplete, continue with the next small, different tool call. If it is complete, answer final text."
        : "Your next response MUST be final text for the user, not another tool call.",
      "Use observed tool results as evidence.",
      "Do not repeat the exact same tool call unless the previous result failed and retrying is clearly necessary.",
    ].join("\n"));
  }

  if (toolCallRequired(params)) {
    const bashCommand = requestedBashCommand(lastUserText(messages));
    parts.push([
      "Tool-use enforcement:",
      "The latest user explicitly requested a tool/command/file operation.",
      "Your next response MUST be only one valid <tool_call>{...}</tool_call> wrapper.",
      "Do not answer from memory or infer command output. Do not include explanation or final text before the tool result exists.",
      "For bash/pwd-style requests, call bash with the requested command.",
      bashCommand ? `Detected bash command hint: ${bashCommand}` : "",
    ].filter(Boolean).join("\n"));
  }

  return parts.join("\n\n").trim() || lastUserText(messages);
}

function parseToolCalls(text) {
  const calls = [];
  let remaining = text || "";
  const parts = [];
  const parsePayload = (raw) => {
    const attempts = [raw, raw.replace(/>\s*$/, "")];
    const lastBrace = raw.lastIndexOf("}");
    if (lastBrace !== -1) attempts.push(raw.slice(0, lastBrace + 1));
    for (const attempt of attempts) {
      try { return JSON.parse(attempt); }
      catch {}
    }
    return null;
  };
  const normalizedCalls = (parsed) => {
    const items = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.tool_calls)
      ? parsed.tool_calls
      : [parsed];
    return items.map((item) => {
      const fn = item?.function || item || {};
      let args = fn.arguments ?? item?.arguments ?? {};
      if (typeof args === "string") {
        try { args = JSON.parse(args); }
        catch {}
      }
      return { name: fn.name || item?.name || "", arguments: args };
    }).filter((item) => item.name);
  };
  const pushParsed = (parsed) => {
    for (const item of normalizedCalls(parsed)) {
      calls.push({
        id: "call_" + crypto.randomUUID().replace(/-/g, "").slice(0, 16),
        type: "function",
        function: {
          name: item.name,
          arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments || {}),
        },
      });
    }
  };
  while (true) {
    const start = remaining.indexOf("<tool_call>");
    if (start === -1) { parts.push(remaining); break; }
    parts.push(remaining.slice(0, start));
    const end = remaining.indexOf("</tool_call>", start + 11);
    const raw = end === -1
      ? remaining.slice(start + 11).trim()
      : remaining.slice(start + 11, end).trim();
    const parsed = parsePayload(raw);
    if (parsed) {
      pushParsed(parsed);
    } else {
      parts.push(`<tool_call>${raw}</tool_call>`);
    }
    if (end === -1) break;
    remaining = remaining.slice(end + 12);
  }
  if (calls.length === 0) {
    const stripped = String(text || "")
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```$/i, "")
      .trim();
    const parsed = parsePayload(stripped);
    if (parsed && normalizedCalls(parsed).length > 0) {
      pushParsed(parsed);
      return { textContent: "", toolCalls: calls };
    }
  }
  return { textContent: parts.join("").trim(), toolCalls: calls };
}

function toolName(tool) {
  return tool?.function?.name || tool?.name || "";
}

function toolSchema(params, name) {
  const needle = String(name || "");
  return (Array.isArray(params?.tools) ? params.tools : [])
    .map((tool) => tool?.function || tool)
    .find((tool) => tool?.name === needle) || null;
}

function parseCallArguments(call) {
  const raw = call?.function?.arguments ?? "{}";
  if (typeof raw !== "string") return raw || {};
  try { return JSON.parse(raw || "{}"); }
  catch { return null; }
}

function callSignature(call) {
  const name = call?.function?.name || "";
  const args = parseCallArguments(call) || {};
  if (name === "bash" && typeof args.command === "string") return `${name}:${args.command.trim()}`;
  return `${name}:${JSON.stringify(args)}`;
}

function priorToolCallSignatures(messages) {
  const signatures = new Set();
  for (const message of messages || []) {
    if (Array.isArray(message?.tool_calls)) {
      for (const call of message.tool_calls) signatures.add(callSignature(call));
    }
    const content = messageContent(message?.content);
    if (content && String(content).includes("<tool_call>")) {
      for (const call of parseToolCalls(content).toolCalls) signatures.add(callSignature(call));
    }
  }
  return signatures;
}

function finalAdmitsIncomplete(text) {
  return /(n[aã]o|not|missing|faltam?|incomplet|ainda|still).{0,100}(criad|created|feito|done|conclu|arquivo|file|folder|pasta)|(?:(criad|created|feito|done|conclu|arquivo|file|folder|pasta).{0,100}(n[aã]o|not|missing|faltam?|incomplet|ainda|still))/i.test(String(text || ""));
}

function riskyBashCommand(command) {
  const value = String(command || "");
  const heredocs = value.match(/<<-?\s*['"]?[A-Za-z0-9_]+['"]?/g) || [];
  return value.length > 8000 || heredocs.length > 1;
}

function validateToolCall(call, params) {
  const name = call?.function?.name || "";
  if (!name) return { ok: false, reason: "missing_tool_name" };
  const knownNames = new Set((Array.isArray(params?.tools) ? params.tools : []).map(toolName).filter(Boolean));
  if (knownNames.size > 0 && !knownNames.has(name)) return { ok: false, reason: `unknown_tool:${name}` };

  const args = parseCallArguments(call);
  if (!args || typeof args !== "object" || Array.isArray(args)) return { ok: false, reason: `invalid_arguments:${name}` };

  const schema = toolSchema(params, name);
  const required = Array.isArray(schema?.parameters?.required) ? schema.parameters.required : [];
  for (const field of required) {
    if (args[field] === undefined || args[field] === null || args[field] === "") {
      return { ok: false, reason: `missing_argument:${name}.${field}` };
    }
  }

  if (name === "bash") {
    if (typeof args.command !== "string" || !args.command.trim()) return { ok: false, reason: "missing_argument:bash.command" };
    if (riskyBashCommand(args.command)) return { ok: false, reason: "risky_bash_command" };
  }

  return { ok: true };
}

function validateHarnessResult(params, parsed) {
  const tools = Array.isArray(params?.tools) ? params.tools : [];
  const messages = Array.isArray(params?.messages) ? params.messages : [];
  const text = parsed?.textContent?.trim() || "";
  const calls = Array.isArray(parsed?.toolCalls) ? parsed.toolCalls : [];

  if (tools.length === 0) return text || calls.length > 0 ? { ok: true } : { ok: false, reason: "empty_response" };

  if (hasToolResult(messages)) {
    const canContinue = canContinueAfterToolResult(params);
    if (calls.length > 0) {
      if (!canContinue) return { ok: false, reason: "tool_call_after_result" };
      const prior = priorToolCallSignatures(messages);
      for (const call of calls) {
        const result = validateToolCall(call, params);
        if (!result.ok) return result;
        if (prior.has(callSignature(call))) return { ok: false, reason: "repeated_tool_call_after_result" };
      }
      return { ok: true };
    }
    if (!text) return { ok: false, reason: "empty_final_after_result" };
    if (canContinue && finalAdmitsIncomplete(text)) return { ok: false, reason: "final_says_incomplete" };
    return { ok: true };
  }

  if (toolCallRequired(params) && calls.length === 0) return { ok: false, reason: "missing_tool_call" };
  for (const call of calls) {
    const result = validateToolCall(call, params);
    if (!result.ok) return result;
  }

  if (!text && calls.length === 0) return { ok: false, reason: "empty_response" };
  return { ok: true };
}

function buildHarnessRepairPrompt(params, reason, badText) {
  const base = buildPrompt(params);
  const messages = Array.isArray(params?.messages) ? params.messages : [];
  const bad = String(badText || "").slice(0, 1200);
  const common = [
    base,
    "Harness correction:",
    `The previous assistant response was rejected by the local harness because: ${reason}.`,
    bad ? `Rejected response excerpt:\n${bad}` : "",
  ].filter(Boolean);

  const canContinue = canContinueAfterToolResult(params);
  if (hasToolResult(messages) && !canContinue) {
    common.push(
      "A tool result already exists. Produce final user-facing text only.",
      "Do not output <tool_call>. Do not call any tool again.",
      "Use the observed tool result exactly and answer concisely."
    );
  } else if (hasToolResult(messages) && canContinue) {
    common.push(
      "A tool result already exists for a file/code task.",
      "If the task is incomplete, produce exactly one next <tool_call>{...}</tool_call> wrapper and no other text.",
      "If the task is complete, produce final user-facing text only.",
      "Do not repeat the exact same tool call. Continue with the next small, verifiable step."
    );
  } else {
    common.push(
      "Produce exactly one valid <tool_call>{...}</tool_call> wrapper and no other text.",
      "The tool name must exist in Available tools and arguments must match the schema.",
      "If using bash, use a small verifiable command. Avoid huge heredocs or multiple file writes in one command."
    );
  }

  return common.join("\n\n");
}

async function repairHarnessResponse(params, reason, badText) {
  try {
    const repairText = await browserConversation(buildHarnessRepairPrompt(params, reason, badText));
    const repairParsed = parseToolCalls(repairText);
    const validation = validateHarnessResult(params, repairParsed);
    if (validation.ok) {
      log("harness repair via Node replay:", reason);
      return { text: repairText, parsed: repairParsed };
    }
    log("harness repair rejected:", validation.reason);
  } catch (err) {
    log("harness repair failed:", err.message);
  }
  return null;
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
        let settled = false;
        let emptyCompleteTimer = null;
        const finish = (destroy = true) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (emptyCompleteTimer) clearTimeout(emptyCompleteTimer);
          if (destroy) res.destroy();
          resolve({ status: res.statusCode, headers: res.headers, text: buffer });
        };
        const timer = setTimeout(() => finish(true), maxTime);
        res.on("data", chunk => {
          buffer += chunk;
          if (buffer.includes("data: [DONE]")) {
            finish(true);
            return;
          }
          if (buffer.includes("message_stream_complete")) {
            const summary = summarizeSSE(buffer);
            if (summary.contentAppends > 0) {
              finish(true);
              return;
            }
            if (!emptyCompleteTimer) {
              emptyCompleteTimer = setTimeout(() => finish(true), 5000);
            }
          }
        });
        res.on("close", () => {
          finish(false);
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

function summarizeSSE(text) {
  const summary = { dataLines: 0, jsonLines: 0, types: {}, paths: {}, contentAppends: 0, thinkingMentions: 0 };
  for (const line of (text || "").split("\n")) {
    if (!line.startsWith("data: ")) continue;
    summary.dataLines++;
    const payload = line.slice(6);
    if (payload === "[DONE]") continue;
    if (payload.toLowerCase().includes("thinking")) summary.thinkingMentions++;
    try {
      const obj = JSON.parse(payload);
      summary.jsonLines++;
      if (obj.type) summary.types[obj.type] = (summary.types[obj.type] || 0) + 1;
      if (obj.p) summary.paths[obj.p] = (summary.paths[obj.p] || 0) + 1;
      if (obj.p === "/message/content/parts/0" && obj.o === "append") summary.contentAppends++;
      if (obj.o === "patch" && Array.isArray(obj.v)) {
        for (const op of obj.v) {
          if (op.p) summary.paths[op.p] = (summary.paths[op.p] || 0) + 1;
          if (op.p === "/message/content/parts/0" && op.o === "append") summary.contentAppends++;
        }
      }
    } catch {}
  }
  return summary;
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
  if (process.env.DEBUG_NODE_TOOLS === "1") {
    log("Node SSE summary:", JSON.stringify(summarizeSSE(result.text)));
    log("Node parsed text:", JSON.stringify(sse.text.slice(0, 300)));
  }

  if (sse.conversation_id) convState.conversation_id = sse.conversation_id;
  if (sse.assistant_id) {
    convState.parent_message_id = sse.assistant_id;
    convState.last_assistant_id = sse.assistant_id;
  }

  return sse.text;
}

async function conversationWithTools(promptText, params) {
  try {
    const nodeText = await browserConversation(promptText);
    const nodeParsed = parseToolCalls(nodeText);
    if (process.env.DEBUG_NODE_TOOLS === "1") {
      log("Node parsed toolCalls:", nodeParsed.toolCalls.length);
    }
    const validation = validateHarnessResult(params, nodeParsed);
    if (validation.ok) {
      log("tools response via Node replay");
      return { text: nodeText, parsed: nodeParsed };
    }
    const repaired = await repairHarnessResponse(params, validation.reason, nodeText);
    if (repaired) return repaired;
    log("Node tool replay rejected; falling back to browser:", validation.reason);
  } catch (err) {
    log("Node tool replay failed; falling back to browser:", err.message);
  }

  const browserText = await browserConversationViaBrowser(promptText);
  const browserParsed = parseToolCalls(browserText);
  const browserValidation = validateHarnessResult(params, browserParsed);
  if (browserValidation.ok) return { text: browserText, parsed: browserParsed };

  const repaired = await repairHarnessResponse(params, browserValidation.reason, browserText);
  if (repaired) return repaired;

  log("browser fallback response still rejected:", browserValidation.reason);
  return { text: browserText, parsed: browserParsed };
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
    res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key" });
    res.end();
    return;
  }

  if (req.method === "POST" && (req.url === "/v1/chat/completions" || req.url === "/v1/chat/completions-stream")) {
    if (!isAuthorized(req)) { unauthorized(res); return; }
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
              const { text, parsed } = await conversationWithTools(prompt, params);
              streamCompletion(res, text, parsed);
            } else {
              await browserConversationStream(prompt, res);
            }
            return;
          }
          let text;
          let parsed;
          if (Array.isArray(params.tools) && params.tools.length > 0) {
            ({ text, parsed } = await conversationWithTools(prompt, params));
          } else {
            text = await browserConversation(prompt);
            parsed = parseToolCalls(text);
          }
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
    if (!isAuthorized(req)) { unauthorized(res); return; }
    json(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && (req.url === "/v1" || req.url === "/v1/")) {
    if (!isAuthorized(req)) { unauthorized(res); return; }
    json(res, 200, v1Info());
    return;
  }

  if (req.url === "/v1/models") {
    if (!isAuthorized(req)) { unauthorized(res); return; }
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
  log(`Browser backend: ${RELAY}`);
  if (PROXY_API_KEY) log("API key auth enabled");
});
