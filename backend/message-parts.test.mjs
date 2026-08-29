import assert from 'node:assert/strict';
import test from 'node:test';
import { visibleMessagePartsFromAssistant } from './message-parts.mjs';

test('mobile-visible assistant parts exclude raw tool invocations and their input', () => {
  const parts = visibleMessagePartsFromAssistant({
    content: [
      { type: 'thinking', thinking: 'private reasoning' },
      { type: 'tool_use', name: 'ToolSearch', input: { query: 'select:AskUserQuestion' } },
      { type: 'text', text: '正常回复' },
    ],
  });

  assert.deepEqual(parts, [
    { kind: 'think', text: 'private reasoning' },
    { kind: 'gu', text: '正常回复' },
  ]);
});
