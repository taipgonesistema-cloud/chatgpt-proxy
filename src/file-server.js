import http from "http";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";

const PORT = 9226;
const BASE_DIR = process.cwd();

function json(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(JSON.stringify(data));
}

function safePath(p) {
  const resolved = path.resolve(BASE_DIR, p);
  if (!resolved.startsWith(BASE_DIR)) return null;
  return resolved;
}

http.createServer((req, res) => {
  if (req.method === "OPTIONS") return res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }), res.end();

  let body = "";
  req.on("data", c => body += c);
  req.on("end", () => {
    try {
      const { action, filePath, content, oldString, newString, command } = JSON.parse(body || "{}");

      if (action === "read") {
        const fp = safePath(filePath);
        if (!fp) return json(res, 400, { error: "Invalid path" });
        if (!fs.existsSync(fp)) return json(res, 404, { error: "File not found" });
        const data = fs.readFileSync(fp, "utf8");
        return json(res, 200, { content: data });
      }

      if (action === "write") {
        const fp = safePath(filePath);
        if (!fp) return json(res, 400, { error: "Invalid path" });
        const dir = path.dirname(fp);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(fp, content || "", "utf8");
        return json(res, 200, { ok: true });
      }

      if (action === "edit") {
        const fp = safePath(filePath);
        if (!fp) return json(res, 400, { error: "Invalid path" });
        if (!fs.existsSync(fp)) return json(res, 404, { error: "File not found" });
        let data = fs.readFileSync(fp, "utf8");
        if (!data.includes(oldString)) return json(res, 400, { error: "oldString not found in file" });
        data = data.replace(oldString, newString);
        fs.writeFileSync(fp, data, "utf8");
        return json(res, 200, { ok: true });
      }

      if (action === "list") {
        const fp = safePath(filePath || ".");
        if (!fp) return json(res, 400, { error: "Invalid path" });
        if (!fs.existsSync(fp)) return json(res, 404, { error: "Path not found" });
        const entries = fs.readdirSync(fp, { withFileTypes: true });
        const items = entries.map(e => ({
          name: e.name,
          type: e.isDirectory() ? "dir" : "file",
          path: path.relative(BASE_DIR, path.join(fp, e.name)),
        }));
        return json(res, 200, { items, currentDir: path.relative(BASE_DIR, fp) });
      }

      if (action === "mkdir") {
        const fp = safePath(filePath);
        if (!fp) return json(res, 400, { error: "Invalid path" });
        if (fs.existsSync(fp)) return json(res, 400, { error: "Path already exists" });
        fs.mkdirSync(fp, { recursive: true });
        return json(res, 200, { ok: true });
      }

      if (action === "delete") {
        const fp = safePath(filePath);
        if (!fp) return json(res, 400, { error: "Invalid path" });
        if (!fs.existsSync(fp)) return json(res, 404, { error: "Path not found" });
        fs.rmSync(fp, { recursive: true });
        return json(res, 200, { ok: true });
      }

      if (action === "run") {
        try {
          const output = execSync(command || "", { cwd: BASE_DIR, timeout: 30000, encoding: "utf8" });
          return json(res, 200, { stdout: output });
        } catch (err) {
          return json(res, 200, { stdout: err.stdout || "", stderr: err.stderr || "", error: err.message });
        }
      }

      json(res, 400, { error: "Unknown action: " + action });
    } catch (err) {
      json(res, 500, { error: err.message });
    }
  });
}).listen(PORT, () => console.log(`[file-server] Running on http://localhost:${PORT}`));
