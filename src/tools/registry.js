/*
 * Tool registry with register/lookup and OpenAI-compatible schema export
 */

import { validateAgainstSchema, SchemaValidationError } from './schema.js';

export class ToolRegistry {
  constructor() {
    this.tools = new Map();
  }

  register(name, description, parameters, handler, strict = true) {
    if (this.tools.has(name))
      throw new Error(`Tool '${name}' is already registered`);

    const enforcedParams = strict
      ? { ...parameters, additionalProperties: false }
      : parameters;

    this.tools.set(name, { name, description, parameters: enforcedParams, strict, handler });
  }

  unregister(name) {
    return this.tools.delete(name);
  }

  get(name) {
    return this.tools.get(name);
  }

  has(name) {
    return this.tools.has(name);
  }

  listNames() {
    return Array.from(this.tools.keys());
  }

  toOpenAITools() {
    const defs = [];
    for (const tool of this.tools.values()) {
      defs.push({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          strict: tool.strict,
        },
      });
    }
    return defs;
  }

  async execute(toolName, rawArgs, context) {
    const registration = this.tools.get(toolName);
    if (!registration)
      throw new Error(`Unknown tool: '${toolName}'`);

    const validatedArgs = validateAgainstSchema(rawArgs, registration.parameters, `$.${toolName}`);
    const result = await registration.handler(validatedArgs, context);

    if (typeof result === 'string') return result;
    return JSON.stringify(result, null, 2);
  }
}

export const registry = new ToolRegistry();
