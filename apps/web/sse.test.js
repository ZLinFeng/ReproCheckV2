import assert from 'node:assert/strict';
import test from 'node:test';
import { createSSEParser, readSSE } from './sse.js';

test('parses split SSE fields, CRLF boundaries and multiline data', () => {
  const events = [];
  const parser = createSSEParser((item) => events.push(item));
  for (const chunk of ['event: prog', 'ress\r', '\ndata: {"a":', '1}\r\n\r', '\nevent: detail\ndata: one\ndata: two\n\n', ': keepalive\n\n']) parser.push(chunk);
  parser.finish();
  assert.deepEqual(events, [{ event: 'progress', data: '{"a":1}' }, { event: 'detail', data: 'one\ntwo' }]);
});

test('decodes UTF-8 across byte chunks and flushes final event', async () => {
  const bytes = new TextEncoder().encode('event: message\ndata: 测试\n\n');
  const stream = new ReadableStream({ start(controller) {
    for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
    controller.close();
  } });
  const events = [];
  await readSSE(new Response(stream), (event) => events.push(event));
  assert.deepEqual(events, [{ event: 'message', data: '测试' }]);
});

test('rejects an unbounded unterminated event', () => {
  const parser = createSSEParser(() => {});
  assert.throws(() => parser.push('x'.repeat(1024 * 1024 + 1)), /too much data/);
});
