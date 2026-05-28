const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const PORT = Number(process.env.CHATGPT_WORKER_PORT || 9233);
const HOST = process.env.CHATGPT_WORKER_HOST || "127.0.0.1";
const CDP_HOST = process.env.CHATGPT_CDP_HOST || "127.0.0.1";
const CDP_PORT = Number(process.env.CHATGPT_CDP_PORT || 9224);
const USER_DATA_DIR = process.env.CHATGPT_USER_DATA_DIR || defaultUserDataDir();
const HEADLESS = process.env.CHATGPT_HEADLESS === "1" || process.env.CHATGPT_HEADLESS === "true";
const LAUNCH_BROWSER = process.env.CHATGPT_WORKER_LAUNCH !== "0";
const ALLOW_REMOTE = process.env.CHATGPT_WORKER_ALLOW_REMOTE === "1";
const START_URL = process.env.CHATGPT_START_URL || "https://chatgpt.com/";

let browserProcess = null;
let launchPromise = null;
let cdp = null;
let currentTabId = null;
let networkCapture = false;
let networkEnabled = false;
let fetchEnabled = false;
let capturedResponses = [];
let requestPostData = {};
let networkFilterUrls = [""];
let fetchRewrite = null;
let fetchRewriteHistory = [];

function defaultUserDataDir() {
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, "yk-chatgpt-worker-profile");
  }
  if (process.env.XDG_DATA_HOME) return path.join(process.env.XDG_DATA_HOME, "yk-chatgpt-worker-profile");
  if (process.env.HOME) return path.join(process.env.HOME, ".local", "share", "yk-chatgpt-worker-profile");
  return path.join(__dirname, ".profile");
}

function log(...args) {
  console.log("[browser-worker]", ...args);
}

function jsonReply(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key",
  });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 20 * 1024 * 1024) req.destroy();
    });
    req.on("end", () => resolve(body));
    req.on("error", () => resolve(body));
  });
}

function parseBody(body) {
  if (!body) return {};
  if (typeof body !== "string") return body;
  try { return JSON.parse(body); }
  catch { return { value: body }; }
}

function base64EncodeUtf8(value) {
  return Buffer.from(String(value || ""), "utf8").toString("base64");
}

function rewriteConversationPostData(postData, replacementText) {
  const body = JSON.parse(postData || "{}");
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const firstUser = messages.find((message) => message?.author?.role === "user") || messages[0];
  if (!firstUser?.content) return postData;

  firstUser.content.parts = [String(replacementText || "")];
  if (typeof firstUser.create_time === "number") firstUser.create_time = Date.now() / 1000;
  return JSON.stringify(body);
}

function isLoopback(remoteAddress) {
  return remoteAddress === "127.0.0.1"
    || remoteAddress === "::1"
    || remoteAddress === "::ffff:127.0.0.1"
    || remoteAddress === undefined;
}

function httpText(method, requestPath, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      method,
      hostname: CDP_HOST,
      port: CDP_PORT,
      path: requestPath,
      timeout: timeoutMs,
    }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`CDP HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
          return;
        }
        resolve(data);
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("CDP HTTP timeout")); });
    req.end();
  });
}

async function httpJson(method, requestPath, timeoutMs = 10000) {
  const text = await httpText(method, requestPath, timeoutMs);
  try { return JSON.parse(text); }
  catch (err) { throw new Error(`CDP JSON parse failed: ${err.message}: ${text.slice(0, 200)}`); }
}

function commandExists(command) {
  return new Promise((resolve) => {
    const probe = process.platform === "win32" ? "where" : "which";
    const child = spawn(probe, [command], { stdio: "ignore" });
    child.on("exit", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
}

async function findChromePath() {
  if (process.env.CHATGPT_CHROME_PATH) return process.env.CHATGPT_CHROME_PATH;

  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA || "";
    const programFiles = [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"]].filter(Boolean);
    const candidates = [
      ...programFiles.map((base) => path.join(base, "Google", "Chrome", "Application", "chrome.exe")),
      local ? path.join(local, "Google", "Chrome", "Application", "chrome.exe") : "",
      ...programFiles.map((base) => path.join(base, "Microsoft", "Edge", "Application", "msedge.exe")),
      ...programFiles.map((base) => path.join(base, "BraveSoftware", "Brave-Browser", "Application", "brave.exe")),
    ].filter(Boolean);
    const found = candidates.find((candidate) => fs.existsSync(candidate));
    if (found) return found;
    throw new Error("Chrome/Edge not found. Set CHATGPT_CHROME_PATH.");
  }

  for (const command of ["google-chrome", "chromium", "chromium-browser", "microsoft-edge", "brave-browser"]) {
    if (await commandExists(command)) return command;
  }
  throw new Error("Chrome/Chromium not found. Set CHATGPT_CHROME_PATH.");
}

async function isCdpReady() {
  try {
    await httpJson("GET", "/json/version", 1500);
    return true;
  } catch {
    return false;
  }
}

async function waitForCdp(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isCdpReady()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Chrome CDP did not start on ${CDP_HOST}:${CDP_PORT}`);
}

async function launchBrowser() {
  if (await isCdpReady()) return;
  fs.mkdirSync(USER_DATA_DIR, { recursive: true });
  const chromePath = await findChromePath();
  const args = [
    `--remote-debugging-address=${CDP_HOST}`,
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${USER_DATA_DIR}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-dev-shm-usage",
    "--window-size=1280,900",
  ];
  if (HEADLESS) args.push("--headless=new");
  args.push(START_URL);

  log(`launching browser: ${chromePath}`);
  browserProcess = spawn(chromePath, args, { stdio: "ignore" });
  browserProcess.on("exit", (code, signal) => {
    log(`browser exited code=${code} signal=${signal}`);
    browserProcess = null;
    launchPromise = null;
  });
  browserProcess.on("error", (err) => log("browser spawn error:", err.message));
  await waitForCdp();
}

async function ensureBrowser() {
  if (await isCdpReady()) return;
  if (!LAUNCH_BROWSER) throw new Error(`Chrome CDP is not available at ${CDP_HOST}:${CDP_PORT}`);
  if (!launchPromise) launchPromise = launchBrowser();
  await launchPromise;
}

async function listTargets() {
  await ensureBrowser();
  const targets = await httpJson("GET", "/json/list");
  return targets.filter((target) => target.type === "page");
}

async function getTarget(tabId = null) {
  let targets = await listTargets();
  if (tabId) {
    const exact = targets.find((target) => String(target.id) === String(tabId));
    if (exact) return exact;
  }
  const chat = targets.find((target) => String(target.url || "").startsWith("https://chatgpt.com"));
  if (chat) return chat;

  const created = await createTarget(START_URL);
  targets = await listTargets();
  return targets.find((target) => String(target.id) === String(created.id)) || targets[0];
}

async function createTarget(targetUrl) {
  await ensureBrowser();
  const encoded = encodeURIComponent(targetUrl || START_URL);
  try {
    return await httpJson("PUT", `/json/new?${encoded}`);
  } catch {
    return await httpJson("GET", `/json/new?${encoded}`);
  }
}

class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CDP websocket open timeout")), 10000);
      this.ws.addEventListener("open", () => { clearTimeout(timer); resolve(); });
      this.ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("CDP websocket error")); }, { once: true });
    });
    this.ws.addEventListener("message", (event) => this.handleMessage(event.data));
    this.ws.addEventListener("close", () => this.handleClose());
  }

  handleMessage(data) {
    let msg;
    try { msg = JSON.parse(String(data)); }
    catch { return; }
    if (msg.id && this.pending.has(msg.id)) {
      const { resolve, reject, timer } = this.pending.get(msg.id);
      clearTimeout(timer);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else resolve(msg.result || {});
      return;
    }
    if (msg.method) {
      for (const listener of this.listeners) listener(msg.method, msg.params || {});
    }
  }

  handleClose() {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error("CDP websocket closed"));
    }
    this.pending.clear();
    if (cdp === this) {
      cdp = null;
      currentTabId = null;
      networkEnabled = false;
      fetchEnabled = false;
      fetchRewrite = null;
      networkCapture = false;
    }
  }

  onEvent(listener) {
    this.listeners.add(listener);
  }

  async send(method, params = {}, timeoutMs = 30000) {
    await this.ready;
    if (this.ws.readyState !== 1) throw new Error("CDP websocket is not open");
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(payload);
    });
  }

  close() {
    try { this.ws.close(); } catch {}
  }
}

async function connectToTarget(tabId = null) {
  const target = await getTarget(tabId);
  if (!target?.webSocketDebuggerUrl) throw new Error("Target does not expose webSocketDebuggerUrl");
  if (cdp && currentTabId === target.id && cdp.ws?.readyState === 1) return { client: cdp, target };

  if (cdp) cdp.close();
  currentTabId = target.id;
  cdp = new CdpClient(target.webSocketDebuggerUrl);
  cdp.onEvent((method, params) => {
    handleCdpEvent(cdp, method, params).catch((err) => log("event error:", err.message));
  });
  await cdp.ready;
  await cdp.send("Runtime.enable", {}).catch(() => {});
  return { client: cdp, target };
}

async function ensureNetwork(client) {
  if (networkEnabled) return;
  await client.send("Network.enable", { maxPostDataSize: 1048576 });
  networkEnabled = true;
}

async function maybeDisableNetwork() {
  if (!cdp || !networkEnabled || networkCapture) return;
  await cdp.send("Network.disable", {}).catch(() => {});
  networkEnabled = false;
}

async function disableFetchIfEnabled() {
  if (!cdp || !fetchEnabled) return;
  await cdp.send("Fetch.disable", {}).catch(() => {});
  fetchEnabled = false;
}

async function handleFetchRequestPaused(client, params) {
  const request = params.request || {};
  const requestId = params.requestId;
  const url = request.url || "";
  const isTarget = fetchRewrite
    && url.includes(fetchRewrite.filter)
    && !url.includes("prepare")
    && request.method === "POST";

  if (!isTarget) {
    await client.send("Fetch.continueRequest", { requestId }).catch(() => {});
    return;
  }

  let postData = request.postData || "";
  let rewriteError = null;
  try {
    if (fetchRewrite.postData) postData = fetchRewrite.postData;
    else postData = rewriteConversationPostData(postData, fetchRewrite.text);
  } catch (err) {
    rewriteError = err.message;
  }

  fetchRewriteHistory.push({
    requestId,
    url,
    requestHeaders: request.headers || {},
    originalPostData: request.postData || null,
    rewrittenPostData: rewriteError ? null : postData,
    rewriteError,
    captureOnly: fetchRewrite.captureOnly === true,
    timestamp: Date.now(),
  });
  if (fetchRewriteHistory.length > 20) fetchRewriteHistory = fetchRewriteHistory.slice(-20);

  const shouldDisable = fetchRewrite.once !== false;
  const captureOnly = fetchRewrite.captureOnly === true;
  fetchRewrite = null;

  if (captureOnly) {
    const body = rewriteError
      ? JSON.stringify({ error: rewriteError })
      : 'event: delta_encoding\ndata: "v1"\n\ndata: {"type":"message_stream_complete"}\n\ndata: [DONE]\n\n';
    await client.send("Fetch.fulfillRequest", {
      requestId,
      responseCode: rewriteError ? 500 : 200,
      responseHeaders: [{ name: "Content-Type", value: rewriteError ? "application/json" : "text/event-stream; charset=utf-8" }],
      body: base64EncodeUtf8(body),
    }).catch(() => {});
    if (shouldDisable) await disableFetchIfEnabled();
    return;
  }

  const continueParams = rewriteError
    ? { requestId }
    : { requestId, postData: base64EncodeUtf8(postData) };
  await client.send("Fetch.continueRequest", continueParams).catch(() => {});
  if (shouldDisable) await disableFetchIfEnabled();
}

async function handleCdpEvent(client, method, params) {
  if (client !== cdp) return;

  if (method === "Fetch.requestPaused") {
    await handleFetchRequestPaused(client, params);
    return;
  }

  if (method === "Network.requestWillBeSent") {
    if (networkCapture && params.request?.method !== "GET" && params.request?.postData) {
      requestPostData[params.requestId] = params.request.postData;
    }
    return;
  }

  if (!networkCapture) return;

  if (method === "Network.responseReceived") {
    const url = params.response?.url || "";
    if (!networkFilterUrls.some((filter) => url.includes(filter))) return;
    capturedResponses.push({
      requestId: params.requestId,
      url,
      status: params.response.status,
      statusText: params.response.statusText,
      headers: params.response.headers,
      mimeType: params.response.mimeType,
      type: params.type,
      postData: requestPostData[params.requestId] || null,
      timestamp: Date.now(),
    });
    delete requestPostData[params.requestId];
    return;
  }

  if (method === "Network.webSocketCreated") {
    capturedResponses.push({
      requestId: `ws_${params.url}`,
      url: params.url,
      type: "WebSocket",
      event: "created",
      timestamp: Date.now(),
    });
    return;
  }

  if (method === "Network.webSocketFrameReceived") {
    capturedResponses.push({
      requestId: `ws_frame_${Date.now()}`,
      url: "WebSocket Frame Received",
      type: "WebSocket",
      event: "frameReceived",
      data: params.response?.payloadData,
      timestamp: Date.now(),
    });
    return;
  }

  if (method === "Network.webSocketFrameSent") {
    capturedResponses.push({
      requestId: `ws_frame_${Date.now()}`,
      url: "WebSocket Frame Sent",
      type: "WebSocket",
      event: "frameSent",
      data: params.response?.payloadData,
      timestamp: Date.now(),
    });
    return;
  }

  if (method === "Network.loadingFinished") {
    const entry = capturedResponses.find((item) => item.requestId === params.requestId);
    if (!entry || entry.body) return;
    try {
      const result = await client.send("Network.getResponseBody", { requestId: params.requestId }, 10000);
      entry.body = result.body;
      entry.base64Encoded = result.base64Encoded;
    } catch {}
  }
}

async function handleRoute(req, res, parsed, body) {
  const pathname = parsed.pathname;
  const query = Object.fromEntries(parsed.searchParams.entries());

  if (pathname === "/ping") {
    jsonReply(res, 200, {
      ok: true,
      backend: "browser-worker",
      host: HOST,
      port: PORT,
      cdp: `${CDP_HOST}:${CDP_PORT}`,
      cdpReady: await isCdpReady(),
      currentTabId,
      headless: HEADLESS,
    });
    return;
  }

  if (pathname === "/status") {
    let current = null;
    try {
      const target = currentTabId ? await getTarget(currentTabId) : await getTarget();
      current = target ? { id: target.id, url: target.url, title: target.title } : null;
    } catch {}
    jsonReply(res, 200, {
      result: {
        ok: true,
        backend: "browser-worker",
        cdpReady: await isCdpReady(),
        currentTabId,
        current,
        networkCapture,
        fetchRewriteActive: !!fetchRewrite,
        headless: HEADLESS,
      },
    });
    return;
  }

  if (pathname === "/tabs") {
    const tabs = await listTargets();
    jsonReply(res, 200, {
      result: tabs.map((tab) => ({
        id: tab.id,
        url: tab.url,
        title: tab.title,
        active: String(tab.id) === String(currentTabId),
      })),
    });
    return;
  }

  if (pathname === "/newTab") {
    const target = await createTarget(query.url || body || START_URL);
    currentTabId = target.id;
    jsonReply(res, 200, { result: { ok: true, id: target.id, url: target.url } });
    return;
  }

  if (pathname === "/activateTab") {
    const id = query.id || body;
    if (!id) throw new Error("Missing tab id");
    await httpText("GET", `/json/activate/${encodeURIComponent(id)}`).catch(() => "");
    currentTabId = id;
    jsonReply(res, 200, { result: { ok: true } });
    return;
  }

  if (pathname === "/evalAsync") {
    const timeoutMs = Math.max(1000, Math.min(Number(query.timeout || query.timeoutMs || 30000), 300000));
    const expression = body || query.code;
    if (!expression) throw new Error("Missing JS expression");
    const { client } = await connectToTarget(query.tabId || null);
    const result = await client.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    }, timeoutMs);
    if (result.exceptionDetails) {
      jsonReply(res, 200, { result: { ok: false, error: result.exceptionDetails.text || "Runtime exception" } });
      return;
    }
    jsonReply(res, 200, { result: { ok: true, result: result.result?.value } });
    return;
  }

  if (pathname === "/networkStart") {
    const { client } = await connectToTarget(query.tabId || null);
    networkCapture = true;
    networkFilterUrls = query.filter ? [query.filter] : [""];
    capturedResponses = [];
    requestPostData = {};
    await ensureNetwork(client);
    jsonReply(res, 200, { result: { ok: true, message: "Network capture started" } });
    return;
  }

  if (pathname === "/networkResponses") {
    jsonReply(res, 200, { result: { ok: true, responses: capturedResponses } });
    return;
  }

  if (pathname === "/networkStop") {
    const count = capturedResponses.length;
    networkCapture = false;
    requestPostData = {};
    await maybeDisableNetwork();
    jsonReply(res, 200, { result: { ok: true, count } });
    return;
  }

  if (pathname === "/rewriteConversationStart") {
    const payload = parseBody(body);
    const { client } = await connectToTarget(payload.tabId || query.tabId || null);
    fetchRewrite = {
      filter: payload.filter || query.filter || "/backend-api/f/conversation",
      text: payload.text || query.text || "",
      postData: payload.postData || null,
      once: payload.once !== false && query.once !== "false",
      captureOnly: payload.captureOnly === true || query.captureOnly === "true",
    };
    await client.send("Fetch.enable", {
      patterns: [{ urlPattern: "*://chatgpt.com/backend-api/f/conversation*", requestStage: "Request" }],
    });
    fetchEnabled = true;
    jsonReply(res, 200, { result: { ok: true, rewrite: { ...fetchRewrite, postData: fetchRewrite.postData ? "<provided>" : null } } });
    return;
  }

  if (pathname === "/rewriteConversationStatus") {
    jsonReply(res, 200, { result: { ok: true, active: !!fetchRewrite, rewrite: fetchRewrite, history: fetchRewriteHistory } });
    return;
  }

  if (pathname === "/rewriteConversationStop") {
    fetchRewrite = null;
    await disableFetchIfEnabled();
    jsonReply(res, 200, { result: { ok: true } });
    return;
  }

  jsonReply(res, 404, { result: { ok: false, error: `Unknown path: ${pathname}` } });
}

const server = http.createServer(async (req, res) => {
  if (!ALLOW_REMOTE && !isLoopback(req.socket.remoteAddress)) {
    jsonReply(res, 403, { error: "browser-worker only accepts loopback clients" });
    return;
  }
  if (req.method === "OPTIONS") {
    jsonReply(res, 204, {});
    return;
  }

  const parsed = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
  const body = req.method === "GET" ? "" : await readBody(req);
  try {
    await handleRoute(req, res, parsed, body);
  } catch (err) {
    jsonReply(res, 500, { result: { ok: false, error: err.message }, error: err.message });
  }
});

server.listen(PORT, HOST, () => {
  log(`listening on http://${HOST}:${PORT}`);
  log(`CDP target http://${CDP_HOST}:${CDP_PORT}, profile ${USER_DATA_DIR}`);
  if (LAUNCH_BROWSER) {
    ensureBrowser().catch((err) => log("browser not ready:", err.message));
  }
});

function shutdown() {
  try { if (cdp) cdp.close(); } catch {}
  try { if (browserProcess) browserProcess.kill(); } catch {}
}

process.on("SIGINT", () => { shutdown(); process.exit(0); });
process.on("SIGTERM", () => { shutdown(); process.exit(0); });
