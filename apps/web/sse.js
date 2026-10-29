export function createSSEParser(onEvent) {
  let buffer = '';
  let event = 'message';
  let data = [];
  let dataLength = 0;

  function line(value) {
    if (value === '') {
      if (data.length) onEvent({ event, data: data.join('\n') });
      event = 'message';
      data = [];
      dataLength = 0;
      return;
    }
    if (value.startsWith(':')) return;
    const colon = value.indexOf(':');
    const field = colon < 0 ? value : value.slice(0, colon);
    let content = colon < 0 ? '' : value.slice(colon + 1);
    if (content.startsWith(' ')) content = content.slice(1);
    if (field === 'event') event = content;
    if (field === 'data') {
      dataLength += content.length + 1;
      if (dataLength > 1024 * 1024) throw new Error('The server returned too much data.');
      data.push(content);
    }
  }

  function consume(final = false) {
    let start = 0;
    for (let index = 0; index < buffer.length; index++) {
      const char = buffer[index];
      if (char !== '\n' && char !== '\r') continue;
      if (char === '\r' && index === buffer.length - 1 && !final) break;
      line(buffer.slice(start, index));
      if (char === '\r' && buffer[index + 1] === '\n') index++;
      start = index + 1;
    }
    buffer = buffer.slice(start);
    if (final) {
      if (buffer) line(buffer);
      line('');
      buffer = '';
    }
    if (buffer.length > 1024 * 1024) throw new Error('The server returned too much data.');
  }

  return {
    push(chunk) { buffer += chunk; consume(); },
    finish() { consume(true); },
  };
}

export async function readSSE(response, onEvent) {
  if (!response.body) throw new Error('The browser could not read the live response.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = createSSEParser(onEvent);
  let finished = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      parser.push(decoder.decode(value, { stream: true }));
    }
    parser.push(decoder.decode());
    parser.finish();
    finished = true;
  } finally {
    if (!finished) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
