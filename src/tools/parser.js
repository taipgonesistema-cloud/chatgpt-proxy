/*
 * Streaming parser for <tool_call> tags.
 * Supports complete tags, incomplete tags where the JSON object is closed
 * but the model forgot to emit </tool_call>, and loose JSON tool objects.
 */

import { TOOL_START_TAG, TOOL_END_TAG, makeToolCallId } from './types.js';

function parseJsonObjectPrefix(input) {
  const start = input.search(/\S/);
  if (start === -1 || input[start] !== '{') return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < input.length; i++) {
    const ch = input[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === '{') depth++;
    if (ch === '}') depth--;

    if (depth === 0) {
      const endIndex = i + 1;
      try {
        return { value: JSON.parse(input.slice(start, endIndex)), endIndex };
      } catch {
        return null;
      }
    }
  }

  return null;
}

function normalizeToolCall(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  const name = parsed.name || '';
  if (!name) return null;

  let args = {};
  if (parsed.arguments !== undefined) {
    args = typeof parsed.arguments === 'string'
      ? JSON.parse(parsed.arguments || '{}')
      : parsed.arguments;
  } else {
    const { name: _name, ...rest } = parsed;
    args = rest;
  }

  return { id: makeToolCallId(), name, arguments: args || {} };
}

function findLooseToolCall(input) {
  let searchFrom = 0;

  while (searchFrom < input.length) {
    const startIndex = input.indexOf('{', searchFrom);
    if (startIndex === -1) return null;

    const prefix = parseJsonObjectPrefix(input.slice(startIndex));
    if (!prefix) {
      searchFrom = startIndex + 1;
      continue;
    }

    const value = prefix.value;
    const hasArguments = value && typeof value === 'object'
      && Object.prototype.hasOwnProperty.call(value, 'arguments');
    const call = hasArguments ? normalizeToolCall(value) : null;

    if (call) {
      return {
        startIndex,
        endIndex: startIndex + prefix.endIndex,
        call,
      };
    }

    searchFrom = startIndex + 1;
  }

  return null;
}

function parseToolPayload(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  try {
    return normalizeToolCall(JSON.parse(trimmed));
  } catch {
    const prefix = parseJsonObjectPrefix(trimmed);
    if (!prefix) return null;
    return normalizeToolCall(prefix.value);
  }
}

export class StreamingToolParser {
  constructor() {
    this.buffer = '';
    this.insideTool = false;
    this.emittedToolCallCount = 0;
  }

  feed(chunk) {
    this.buffer += chunk;
    const result = { text: '', toolCalls: [] };

    while (this.buffer.length > 0) {
      if (!this.insideTool) {
        const startIdx = this.buffer.indexOf(TOOL_START_TAG);
        const orphanEndIdx = this.buffer.indexOf(TOOL_END_TAG);
        const loose = findLooseToolCall(this.buffer);

        if (orphanEndIdx !== -1
          && (startIdx === -1 || orphanEndIdx < startIdx)
          && (!loose || orphanEndIdx < loose.startIndex)) {
          result.text += this.buffer.substring(0, orphanEndIdx);
          this.buffer = this.buffer.substring(orphanEndIdx + TOOL_END_TAG.length);
          continue;
        }

        if (loose && (startIdx === -1 || loose.startIndex < startIdx)) {
          result.text += this.buffer.substring(0, loose.startIndex);
          result.toolCalls.push(loose.call);
          this.emittedToolCallCount++;
          this.buffer = this.buffer.substring(loose.endIndex);
          continue;
        }

        if (startIdx !== -1) {
          result.text += this.buffer.substring(0, startIdx);
          this.insideTool = true;
          this.buffer = this.buffer.substring(startIdx + TOOL_START_TAG.length);
          continue;
        }

        let flushIndex = this.buffer.length;
        for (let i = 1; i <= TOOL_START_TAG.length; i++) {
          if (this.buffer.endsWith(TOOL_START_TAG.substring(0, i))) {
            flushIndex = this.buffer.length - i;
            break;
          }
        }

        result.text += this.buffer.substring(0, flushIndex);
        this.buffer = this.buffer.substring(flushIndex);
        break;
      }

      const endIdx = this.buffer.indexOf(TOOL_END_TAG);
      if (endIdx !== -1) {
        const call = parseToolPayload(this.buffer.substring(0, endIdx));
        if (call) {
          result.toolCalls.push(call);
          this.emittedToolCallCount++;
        }
        this.insideTool = false;
        this.buffer = this.buffer.substring(endIdx + TOOL_END_TAG.length);
        continue;
      }

      const prefix = parseJsonObjectPrefix(this.buffer);
      if (prefix) {
        const rest = this.buffer.substring(prefix.endIndex);
        if (!rest.trim()) break;

        const call = normalizeToolCall(prefix.value);
        if (call) {
          result.toolCalls.push(call);
          this.emittedToolCallCount++;
        }
        this.insideTool = false;
        this.buffer = this.buffer.substring(prefix.endIndex);
        continue;
      }

      break;
    }

    return result;
  }

  flush() {
    const result = { text: '', toolCalls: [] };

    if (!this.buffer) return result;

    if (this.insideTool) {
      const prefix = parseJsonObjectPrefix(this.buffer);
      if (prefix) {
        const call = normalizeToolCall(prefix.value);
        if (call) {
          result.toolCalls.push(call);
          this.emittedToolCallCount++;
        }
        result.text = this.buffer.substring(prefix.endIndex);
      }
    } else {
      const parsed = parseToolCallsFromContent(this.buffer);
      result.text = parsed.textContent;
      result.toolCalls.push(...parsed.toolCalls);
      this.emittedToolCallCount += parsed.toolCalls.length;
    }

    this.buffer = '';
    this.insideTool = false;
    return result;
  }

  getEmittedToolCallCount() { return this.emittedToolCallCount; }
  isInsideTool() { return this.insideTool; }
}

export function parseToolCallsFromContent(content) {
  const toolCalls = [];
  let textContent = '';
  let pos = 0;

  while (pos < content.length) {
    const startIdx = content.indexOf(TOOL_START_TAG, pos);
    const orphanEndIdx = content.indexOf(TOOL_END_TAG, pos);
    const loose = findLooseToolCall(content.slice(pos));
    const looseIdx = loose ? pos + loose.startIndex : -1;

    if (orphanEndIdx !== -1
      && (startIdx === -1 || orphanEndIdx < startIdx)
      && (!loose || orphanEndIdx < looseIdx)) {
      textContent += content.slice(pos, orphanEndIdx);
      pos = orphanEndIdx + TOOL_END_TAG.length;
      continue;
    }

    if (loose && (startIdx === -1 || looseIdx < startIdx)) {
      textContent += content.slice(pos, looseIdx);
      toolCalls.push(loose.call);
      pos += loose.endIndex;
      continue;
    }

    if (startIdx === -1) {
      textContent += content.slice(pos);
      break;
    }

    textContent += content.slice(pos, startIdx);
    const bodyStart = startIdx + TOOL_START_TAG.length;
    const endIdx = content.indexOf(TOOL_END_TAG, bodyStart);

    if (endIdx !== -1) {
      const call = parseToolPayload(content.slice(bodyStart, endIdx));
      if (call) toolCalls.push(call);
      else textContent += content.slice(startIdx, endIdx + TOOL_END_TAG.length);
      pos = endIdx + TOOL_END_TAG.length;
      continue;
    }

    const prefix = parseJsonObjectPrefix(content.slice(bodyStart));
    if (prefix) {
      const call = normalizeToolCall(prefix.value);
      if (call) toolCalls.push(call);
      pos = bodyStart + prefix.endIndex;
      continue;
    }

    textContent += content.slice(startIdx);
    break;
  }

  return { textContent: textContent.trim(), toolCalls };
}
