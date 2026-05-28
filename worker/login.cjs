const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const readline = require("node:readline/promises");

const CDP_HOST = process.env.CHATGPT_CDP_HOST || "127.0.0.1";
const CDP_PORT = Number(process.env.CHATGPT_CDP_PORT || 9224);
const USER_DATA_DIR = process.env.CHATGPT_USER_DATA_DIR || defaultUserDataDir();
const START_URL = process.env.CHATGPT_START_URL || "https://chatgpt.com/";
const LOGIN_TIMEOUT_MS = Number(process.env.CHATGPT_LOGIN_TIMEOUT_MS || 10 * 60 * 1000);

function log(...args) {
  console.log("[chatgpt-login]", ...args);
}

function defaultUserDataDir() {
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, "yk-chatgpt-worker-profile");
  }
  if (process.env.XDG_DATA_HOME) return path.join(process.env.XDG_DATA_HOME, "yk-chatgpt-worker-profile");
  if (process.env.HOME) return path.join(process.env.HOME, ".local", "share", "yk-chatgpt-worker-profile");
  return path.join(__dirname, ".profile");
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
    START_URL,
  ];

  log(`opening Chrome: ${chromePath}`);
  log(`profile: ${USER_DATA_DIR}`);
  const child = spawn(chromePath, args, { detached: true, stdio: "ignore" });
  child.unref();
  await waitForCdp();
}

async function ensureBrowser() {
  if (await isCdpReady()) {
    log(`using existing Chrome CDP on ${CDP_HOST}:${CDP_PORT}`);
    return;
  }
  await launchBrowser();
}

async function listTargets() {
  return (await httpJson("GET", "/json/list")).filter((target) => target.type === "page");
}

async function createTarget(targetUrl) {
  const encoded = encodeURIComponent(targetUrl || START_URL);
  try { return await httpJson("PUT", `/json/new?${encoded}`); }
  catch { return await httpJson("GET", `/json/new?${encoded}`); }
}

async function getChatTarget() {
  let targets = await listTargets();
  let target = targets.find((item) => String(item.url || "").startsWith("https://chatgpt.com"));
  if (target) return target;

  const created = await createTarget(START_URL);
  targets = await listTargets();
  target = targets.find((item) => String(item.id) === String(created.id))
    || targets.find((item) => String(item.url || "").startsWith("https://chatgpt.com"));
  if (!target) throw new Error("Could not open ChatGPT tab");
  return target;
}

class CdpClient {
  constructor(wsUrl) {
    if (typeof WebSocket !== "function") {
      throw new Error("This login helper requires Node.js with global WebSocket support. Use Node 22+.");
    }
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("CDP websocket open timeout")), 10000);
      this.ws.addEventListener("open", () => { clearTimeout(timer); resolve(); });
      this.ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("CDP websocket error")); }, { once: true });
    });
    this.ws.addEventListener("message", (event) => this.handleMessage(event.data));
    this.ws.addEventListener("close", () => {
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error("CDP websocket closed"));
      }
      this.pending.clear();
    });
  }

  handleMessage(data) {
    let msg;
    try { msg = JSON.parse(String(data)); }
    catch { return; }
    if (!msg.id || !this.pending.has(msg.id)) return;
    const { resolve, reject, timer } = this.pending.get(msg.id);
    clearTimeout(timer);
    this.pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
    else resolve(msg.result || {});
  }

  async send(method, params = {}, timeoutMs = 30000) {
    await this.ready;
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    try { this.ws.close(); } catch {}
  }
}

async function loginState(client) {
  const expression = `(() => {
    const text = document.body?.innerText || "";
    const composer = document.querySelector('#prompt-textarea,[data-testid="composer-root"],[data-testid="composer-text-area"]');
    const sendButton = document.querySelector('#composer-submit-button,[data-testid="send-button"]');
    const isChatReady = location.hostname === "chatgpt.com"
      && /chatgpt/i.test(document.title || text)
      && !!composer
      && !/log in|login|sign up|entrar|criar conta/i.test(text);
    return {
      url: location.href,
      title: document.title,
      hasComposer: !!composer,
      hasSendButton: !!sendButton,
      isChatReady,
      hasLoginText: /log in|login|sign up|entrar|criar conta/i.test(text),
      preview: text.slice(0, 240),
    };
  })()`;
  const result = await client.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: false }, 10000);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "Runtime exception");
  return result.result?.value || {};
}

async function waitForEnterAfterReady() {
  if (process.env.CHATGPT_LOGIN_HOLD === "0" || !process.stdin.isTTY) return;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    await rl.question("[chatgpt-login] Login pronto. Pressione Enter para encerrar este helper e deixar o Chrome aberto... ");
  } finally {
    rl.close();
  }
}

async function main() {
  await ensureBrowser();
  const target = await getChatTarget();
  log(`ChatGPT tab: ${target.url}`);
  log("If you are not logged in, complete login in the opened Chrome window.");

  const client = new CdpClient(target.webSocketDebuggerUrl);
  await client.ready;
  await client.send("Runtime.enable", {}).catch(() => {});
  await client.send("Page.bringToFront", {}).catch(() => {});

  const initialState = await loginState(client).catch(() => null);
  if (!String(initialState?.url || "").startsWith("https://chatgpt.com")) {
    await client.send("Page.navigate", { url: START_URL }).catch(() => {});
  }

  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  let lastPrint = 0;
  while (Date.now() < deadline) {
    const state = await loginState(client).catch((err) => ({ error: err.message }));
    if (state.isChatReady || (state.hasComposer && state.hasSendButton && !state.hasLoginText)) {
      log("login ready: ChatGPT composer detected.");
      log("Next: npm run worker");
      await waitForEnterAfterReady();
      client.close();
      return;
    }
    if (Date.now() - lastPrint > 5000) {
      lastPrint = Date.now();
      log(state.error ? `waiting: ${state.error}` : `waiting for login, url=${state.url || "unknown"}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  client.close();
  throw new Error("Login timeout. Run npm run login again after completing browser login.");
}

main().catch((err) => {
  console.error(`[chatgpt-login] ERROR: ${err.message}`);
  process.exit(1);
});
