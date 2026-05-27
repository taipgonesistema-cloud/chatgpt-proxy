import http from "http";
import fs from "fs";
import path from "path";
import { execFileSync, execSync } from "child_process";

const PORT = 9226;
let baseDir = process.cwd();

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
  const resolved = path.resolve(baseDir, p || ".");
  const relative = path.relative(baseDir, resolved);
  if (relative && (relative.startsWith("..") || path.isAbsolute(relative))) return null;
  return resolved;
}

function setBaseDir(dirPath) {
  const next = path.resolve(String(dirPath || ""));
  if (!fs.existsSync(next)) throw new Error("Folder not found");
  if (!fs.statSync(next).isDirectory()) throw new Error("Path is not a folder");
  baseDir = next;
  return baseDir;
}

function psString(value) {
  return `'${String(value || "").replace(/'/g, "''")}'`;
}

function findPowerShell() {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
  const candidates = [
    process.env.POWERSHELL_EXE,
    path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    path.join(systemRoot, "Sysnative", "WindowsPowerShell", "v1.0", "powershell.exe"),
    path.join(systemRoot, "SysWOW64", "WindowsPowerShell", "v1.0", "powershell.exe"),
    "powershell.exe",
    "pwsh.exe",
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (path.isAbsolute(candidate) && fs.existsSync(candidate)) return candidate;
    if (!path.isAbsolute(candidate)) return candidate;
  }

  throw new Error("PowerShell not found");
}

function chooseFolder(initialDir) {
  const selected = fs.existsSync(initialDir || "") ? path.resolve(initialDir) : baseDir;
  const script = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::EnableVisualStyles()
$form = New-Object System.Windows.Forms.Form
$form.TopMost = $true
$form.StartPosition = 'CenterScreen'
$form.Width = 1
$form.Height = 1
$form.ShowInTaskbar = $false
$form.Opacity = 0
$form.Show()
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = 'Escolha a pasta do projeto'
$dialog.ShowNewFolderButton = $true
$dialog.SelectedPath = ${psString(selected)}
if ($dialog.ShowDialog($form) -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::UTF8
  Write-Output $dialog.SelectedPath
}
$form.Close()
`;
  const output = execFileSync(findPowerShell(), ["-NoProfile", "-STA", "-Command", script], {
    encoding: "utf8",
    timeout: 120000,
  }).trim();
  return output || null;
}

http.createServer((req, res) => {
  if (req.method === "OPTIONS") return res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }), res.end();

  let body = "";
  req.on("data", c => body += c);
  req.on("end", () => {
    try {
      const { action, filePath, content, oldString, newString, command, dirPath } = JSON.parse(body || "{}");

      if (action === "status") {
        return json(res, 200, { ok: true, baseDir });
      }

      if (action === "setBaseDir") {
        const next = setBaseDir(dirPath || filePath);
        return json(res, 200, { ok: true, baseDir: next });
      }

      if (action === "chooseFolder") {
        const selected = chooseFolder(dirPath || filePath);
        if (!selected) return json(res, 200, { ok: false, cancelled: true, baseDir });
        const next = setBaseDir(selected);
        return json(res, 200, { ok: true, baseDir: next });
      }

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
          path: path.relative(baseDir, path.join(fp, e.name)),
        }));
        return json(res, 200, { items, currentDir: path.relative(baseDir, fp), baseDir });
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
          const output = execSync(command || "", { cwd: baseDir, timeout: 30000, encoding: "utf8" });
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
