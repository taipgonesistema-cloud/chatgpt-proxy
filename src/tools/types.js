/*
 * Tool system types (JS port)
 */

import crypto from 'crypto';

export const TOOL_START_TAG = '<tool_call>';
export const TOOL_END_TAG = '</tool_call>';

export function makeToolCallId() {
  return 'call_' + crypto.randomUUID().replace(/-/g, '').slice(0, 16);
}
