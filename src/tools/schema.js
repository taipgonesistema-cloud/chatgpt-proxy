/*
 * Strict JSON Schema validator for tool calling (JS port)
 */

export class SchemaValidationError extends Error {
  constructor(message, path, value) {
    super(message);
    this.name = 'SchemaValidationError';
    this.path = path;
    this.value = value;
  }
}

export function validateAgainstSchema(value, schema, path = '$') {
  if (schema.nullable && (value === null || value === undefined)) return value;

  switch (schema.type) {
    case 'object':
      return validateObject(value, schema, path);
    case 'array':
      return validateArray(value, schema, path);
    case 'string':
      return validateString(value, schema, path);
    case 'number':
    case 'integer':
      return validateNumber(value, schema, path);
    case 'boolean':
      return validateBoolean(value, schema, path);
    case 'null':
      if (value !== null)
        throw new SchemaValidationError(`Expected null at ${path}, got ${typeof value}`, path, value);
      return null;
    default:
      return value;
  }
}

function validateObject(value, schema, path) {
  if (value === null || value === undefined)
    throw new SchemaValidationError(`Expected object at ${path}, got ${value === null ? 'null' : 'undefined'}`, path, value);
  if (typeof value !== 'object' || Array.isArray(value))
    throw new SchemaValidationError(`Expected object at ${path}, got ${typeof value}`, path, value);

  const obj = value;
  const validated = {};

  if (schema.required) {
    for (const req of schema.required) {
      if (!(req in obj) || obj[req] === undefined)
        throw new SchemaValidationError(`Missing required property '${req}' at ${path}`, `${path}.${req}`, undefined);
    }
  }

  const properties = schema.properties || {};
  const seenKeys = new Set();

  for (const [key, val] of Object.entries(obj)) {
    seenKeys.add(key);
    const propSchema = properties[key];
    if (propSchema) {
      validated[key] = validateAgainstSchema(val, propSchema, `${path}.${key}`);
    } else if (schema.additionalProperties === false) {
      throw new SchemaValidationError(`Unexpected property '${key}' at ${path} (additionalProperties is false)`, `${path}.${key}`, val);
    } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
      validated[key] = validateAgainstSchema(val, schema.additionalProperties, `${path}.${key}`);
    } else {
      validated[key] = val;
    }
  }

  for (const [key, propSchema] of Object.entries(properties)) {
    if (!seenKeys.has(key) && propSchema.default !== undefined)
      validated[key] = propSchema.default;
  }

  return validated;
}

function validateArray(value, schema, path) {
  if (!Array.isArray(value))
    throw new SchemaValidationError(`Expected array at ${path}, got ${typeof value}`, path, value);

  if (schema.minItems !== undefined && value.length < schema.minItems)
    throw new SchemaValidationError(`Array at ${path} has ${value.length} items, minimum is ${schema.minItems}`, path, value);
  if (schema.maxItems !== undefined && value.length > schema.maxItems)
    throw new SchemaValidationError(`Array at ${path} has ${value.length} items, maximum is ${schema.maxItems}`, path, value);

  if (schema.items)
    return value.map((item, i) => validateAgainstSchema(item, schema.items, `${path}[${i}]`));

  return value;
}

function validateString(value, schema, path) {
  if (typeof value !== 'string')
    throw new SchemaValidationError(`Expected string at ${path}, got ${typeof value}`, path, value);
  if (schema.minLength !== undefined && value.length < schema.minLength)
    throw new SchemaValidationError(`String at ${path} is ${value.length} chars, minimum is ${schema.minLength}`, path, value);
  if (schema.maxLength !== undefined && value.length > schema.maxLength)
    throw new SchemaValidationError(`String at ${path} is ${value.length} chars, maximum is ${schema.maxLength}`, path, value);
  if (schema.pattern && !new RegExp(schema.pattern).test(value))
    throw new SchemaValidationError(`String at ${path} does not match pattern '${schema.pattern}'`, path, value);
  if (schema.enum && !schema.enum.includes(value))
    throw new SchemaValidationError(`Value '${value}' at ${path} is not one of [${schema.enum.join(', ')}]`, path, value);
  return value;
}

function validateNumber(value, schema, path) {
  if (typeof value !== 'number' || Number.isNaN(value))
    throw new SchemaValidationError(`Expected number at ${path}, got ${typeof value}`, path, value);
  if (schema.type === 'integer' && !Number.isInteger(value))
    throw new SchemaValidationError(`Expected integer at ${path}, got float ${value}`, path, value);
  if (schema.minimum !== undefined && value < schema.minimum)
    throw new SchemaValidationError(`Number ${value} at ${path} is below minimum ${schema.minimum}`, path, value);
  if (schema.maximum !== undefined && value > schema.maximum)
    throw new SchemaValidationError(`Number ${value} at ${path} is above maximum ${schema.maximum}`, path, value);
  if (schema.enum && !schema.enum.includes(value))
    throw new SchemaValidationError(`Value ${value} at ${path} is not one of [${schema.enum.join(', ')}]`, path, value);
  return value;
}

function validateBoolean(value, schema, path) {
  if (typeof value !== 'boolean')
    throw new SchemaValidationError(`Expected boolean at ${path}, got ${typeof value}`, path, value);
  return value;
}
