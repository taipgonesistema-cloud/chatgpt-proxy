/*
 * Execution loop for tool calling - server-side agentic loop
 */

import { registry } from './registry.js';
import { SchemaValidationError } from './schema.js';
import { parseToolCallsFromContent } from './parser.js';
import { makeToolCallId } from './types.js';

export async function executeToolCalls(toolCalls, context) {
  return await Promise.all(
    toolCalls.map(async (tc) => {
      try {
        if (!registry.has(tc.name)) {
          return {
            toolCallId: tc.id,
            name: tc.name,
            result: JSON.stringify({ error: `Unknown tool: '${tc.name}'` }),
            isError: true,
          };
        }
        const result = await registry.execute(tc.name, tc.arguments, context);
        return { toolCallId: tc.id, name: tc.name, result, isError: false };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const isValidation = err instanceof SchemaValidationError;
        return {
          toolCallId: tc.id,
          name: tc.name,
          result: JSON.stringify({
            error: isValidation ? 'Schema validation failed' : 'Tool execution error',
            details: message,
            ...(isValidation ? { path: err.path } : {}),
          }),
          isError: true,
        };
      }
    })
  );
}

export function buildToolMessage(result) {
  return { role: 'tool', tool_call_id: result.toolCallId, content: result.result };
}

export function buildAssistantToolCallMessage(content, toolCalls) {
  return {
    role: 'assistant',
    content: content || null,
    tool_calls: toolCalls.map(tc => ({
      id: tc.id,
      type: 'function',
      function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
    })),
  };
}

export async function runExecutionLoop(sendToLLM, messages, model, config = {}) {
  const maxTurns = config.maxTurns ?? 10;
  const debug = config.debug ?? false;

  const tools = registry.listNames().length > 0 ? registry.toOpenAITools() : undefined;

  for (let turn = 0; turn < maxTurns; turn++) {
    if (debug) console.log(`[executor] Turn ${turn + 1}/${maxTurns}, messages: ${messages.length}`);

    const response = await sendToLLM(messages, tools, model);

    const hasStructuredToolCalls = response.toolCalls && response.toolCalls.length > 0;
    let parsedFromContent = null;

    if (!hasStructuredToolCalls && response.content) {
      parsedFromContent = parseToolCallsFromContent(response.content);
    }

    const effectiveToolCalls = hasStructuredToolCalls
      ? response.toolCalls
      : parsedFromContent?.toolCalls || [];

    const effectiveContent = parsedFromContent ? parsedFromContent.textContent : response.content;

    if (effectiveToolCalls.length === 0) {
      if (debug) console.log('[executor] No tool calls, loop complete');
      return effectiveContent || '';
    }

    const context = { messages, turn, model };

    if (debug) console.log(`[executor] Executing ${effectiveToolCalls.length} tool calls:`, effectiveToolCalls.map(tc => tc.name));

    const toolResults = await executeToolCalls(effectiveToolCalls, context);

    messages.push(buildAssistantToolCallMessage(effectiveContent, effectiveToolCalls));
    for (const result of toolResults) {
      messages.push(buildToolMessage(result));
    }

    if (debug) console.log(`[executor] Tool results:`, toolResults.map(r => ({ name: r.name, isError: r.isError })));
  }

  throw new Error(`Execution loop exceeded maximum turns (${maxTurns}). The agent may be stuck in a cycle.`);
}
