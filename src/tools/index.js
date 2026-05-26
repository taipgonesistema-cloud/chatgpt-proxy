/*
 * Tool system entry point - registers all file tools and exports
 */

import http from 'http';
import { registry } from './registry.js';
import { StreamingToolParser, parseToolCallsFromContent } from './parser.js';
import { runExecutionLoop, executeToolCalls, buildToolMessage, buildAssistantToolCallMessage } from './executor.js';
import { TOOL_START_TAG, TOOL_END_TAG, makeToolCallId } from './types.js';

const FILE_SERVER = 'http://localhost:9226';

function callFileServer(action, args) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ action, ...args });
    const req = http.request(FILE_SERVER, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      timeout: 30000,
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`File server response parse error: ${e.message}\n${data.slice(0,200)}`)); }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('File server timeout')); });
    req.write(body);
    req.end();
  });
}

const ACTION_MAP = {
  read_file: 'read',
  write_file: 'write',
  edit_file: 'edit',
  list_dir: 'list',
  create_dir: 'mkdir',
  delete_path: 'delete',
  run_command: 'run',
};

function makeHandler(actionName) {
  return async (args, context) => {
    const result = await callFileServer(actionName, args);
    if (result.error) throw new Error(result.error);
    return result;
  };
}

export function registerFileTools() {
  const tools = [
    {
      name: 'read_file',
      description: 'Read the contents of a file at filePath. Returns the file content as a string.',
      params: {
        type: 'object',
        properties: { filePath: { type: 'string', description: 'Path to the file to read' } },
        required: ['filePath'],
      },
    },
    {
      name: 'write_file',
      description: 'Create or completely overwrite a file at filePath with the given content. Creates parent directories if they do not exist.',
      params: {
        type: 'object',
        properties: {
          filePath: { type: 'string', description: 'Path to the file to write' },
          content: { type: 'string', description: 'Full content to write to the file' },
        },
        required: ['filePath', 'content'],
      },
    },
    {
      name: 'edit_file',
      description: 'Edit a file by replacing oldString with newString. Use this for surgical edits rather than rewriting the entire file.',
      params: {
        type: 'object',
        properties: {
          filePath: { type: 'string', description: 'Path to the file to edit' },
          oldString: { type: 'string', description: 'The exact existing text to replace' },
          newString: { type: 'string', description: 'The new text to insert' },
        },
        required: ['filePath', 'oldString', 'newString'],
      },
    },
    {
      name: 'list_dir',
      description: 'List files and directories at the given path. Returns items with name, type (dir/file), and path.',
      params: {
        type: 'object',
        properties: { filePath: { type: 'string', description: 'Directory to list (default: ".")' } },
        required: [],
      },
    },
    {
      name: 'create_dir',
      description: 'Create a directory and all necessary parent directories (like mkdir -p).',
      params: {
        type: 'object',
        properties: { filePath: { type: 'string', description: 'Directory path to create' } },
        required: ['filePath'],
      },
    },
    {
      name: 'delete_path',
      description: 'Delete a file or directory. Directories are deleted recursively.',
      params: {
        type: 'object',
        properties: { filePath: { type: 'string', description: 'Path to delete' } },
        required: ['filePath'],
      },
    },
    {
      name: 'run_command',
      description: 'Run a shell command in the workspace and return its stdout, stderr, and exit code.',
      params: {
        type: 'object',
        properties: { command: { type: 'string', description: 'Shell command to execute' } },
        required: ['command'],
      },
    },
  ];

  for (const t of tools) {
    registry.register(t.name, t.description, t.params, makeHandler(ACTION_MAP[t.name]));
  }
}

export function buildToolSystemPrompt() {
  const toolDefs = registry.toOpenAITools();
  if (toolDefs.length === 0) return '';

  const desc = toolDefs.map(t => {
    const fn = t.function;
    return `- ${fn.name}: ${fn.description || 'No description'}`;
  }).join('\n');

  return `You are an autonomous coding agent with filesystem access.

CRITICAL RULE — You MUST use tools for ALL file operations:
Whenever the user asks you to create, read, edit, delete files/folders, or run commands, you MUST call the corresponding tool using <tool_call> format below.
Do NOT just say "Pronto" or "Done" — actually call the tool and wait for the result.
If you don't call the tool, the operation will NOT happen.

TOOL CALL FORMAT:
<tool_call>{"name":"tool_name","arguments":{...args}}</tool_call>

Rules for tool calls:
- Each <tool_call> MUST have a closing </tool_call> tag
- The JSON must have "name" and "arguments" fields
- You can call MULTIPLE tools in one response (one <tool_call> per tool)
- Create directories FIRST, then write files into them
- Show the user what you're doing, then call the tool, then show the result
- When writing code files, the content MUST be complete, readable, multi-line, and properly indented.
- Do NOT minify HTML, CSS, JavaScript, JSON, or source code unless the user explicitly asks for minified output.
- For HTML files, include normal line breaks around <!DOCTYPE>, <html>, <head>, <style>, <body>, <script>, and closing tags.
- Keep generated project files maintainable: meaningful variable names, indentation, and small sections instead of one-line code.

Available tools:
${desc}

Examples — use EXACTLY this format:
<tool_call>{"name":"create_dir","arguments":{"filePath":"my-project/src"}}</tool_call>
<tool_call>{"name":"write_file","arguments":{"filePath":"my-project/index.html","content":"<h1>Hello</h1>"}}</tool_call>
<tool_call>{"name":"read_file","arguments":{"filePath":"my-project/index.html"}}</tool_call>
<tool_call>{"name":"edit_file","arguments":{"filePath":"my-project/index.html","oldString":"Hello","newString":"Hello World"}}</tool_call>
<tool_call>{"name":"delete_path","arguments":{"filePath":"my-project/old-file.txt"}}</tool_call>
<tool_call>{"name":"run_command","arguments":{"command":"dir"}}</tool_call>`;
}

export {
  registry,
  StreamingToolParser,
  parseToolCallsFromContent,
  runExecutionLoop,
  executeToolCalls,
  buildToolMessage,
  buildAssistantToolCallMessage,
  TOOL_START_TAG,
  TOOL_END_TAG,
  makeToolCallId,
};
