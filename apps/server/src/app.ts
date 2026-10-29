import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { createWebHarness } from './dsh.js';
import { githubRepository, investigate, resultsDir } from './investigation.js';
import { modelsPlugin } from './models.js';
import { searchOnline } from './online-search.js';

declare module 'fastify' {
  interface FastifyInstance {
    createWebHarness: typeof createWebHarness;
    investigate: typeof investigate;
    searchOnline: typeof searchOnline;
  }
}

export const app = Fastify({ logger: true, ajv: { customOptions: { coerceTypes: false, removeAdditional: false } } });
app.register(modelsPlugin);
app.decorate('createWebHarness', createWebHarness);
app.decorate('investigate', investigate);
app.decorate('searchOnline', searchOnline);

const webDir = fileURLToPath(new URL('../../web/', import.meta.url));
for (const [route, file, type] of [
  ['/', 'index.html', 'text/html; charset=utf-8'],
  ['/app.js', 'app.js', 'text/javascript; charset=utf-8'],
  ['/sse.js', 'sse.js', 'text/javascript; charset=utf-8'],
  ['/styles.css', 'styles.css', 'text/css; charset=utf-8'],
] as const) {
  app.get(route, async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (route === '/') reply.header('Content-Security-Policy', "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'");
    return reply.type(type).send(await readFile(join(webDir, file)));
  });
}

app.post<{ Body: { url: string } }>('/investigations', {
  schema: { body: { type: 'object', additionalProperties: false, required: ['url'], properties: {
    url: { type: 'string', minLength: 1, maxLength: 2000 },
  } } },
  preHandler: async (request, reply) => {
    try { githubRepository(request.body.url); } catch { return reply.code(400).send({ message: 'Enter a valid GitHub repository URL.' }); }
  },
}, async (request, reply) => {
  const sessionId = randomUUID();
  const { raw } = reply;
  const controller = new AbortController();
  const timeoutError = new Error('The investigation timed out.');
  const disconnectError = new Error('The client disconnected.');
  const disconnect = () => controller.abort(disconnectError);
  const timer = setTimeout(() => controller.abort(timeoutError), 1800000);
  const send = (event: string, data: object) => {
    if (raw.destroyed || raw.writableEnded) return;
    if (raw.writableLength > 1024 * 1024) { raw.destroy(); return; }
    raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  reply.hijack();
  raw.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' });
  raw.once('close', disconnect);
  send('start', { sessionId });
  try {
    const report = await app.investigate(app, request.body.url, sessionId, controller.signal,
      (stage) => send('progress', { sessionId, stage }), (stage, data) => send('detail', { sessionId, stage, data }));
    if (controller.signal.aborted) throw controller.signal.reason;
    send('message', { sessionId, text: report.summary });
    send('done', { sessionId, finalResponse: report.summary, reportUrl: `/investigations/${sessionId}` });
  } catch (error) {
    if (controller.signal.reason !== disconnectError) {
      const timedOut = controller.signal.reason === timeoutError;
      request.log.error({ timedOut, errorType: error instanceof Error ? error.name : 'unknown' }, 'Investigation failed');
      send('error', { message: timedOut ? timeoutError.message : 'The investigation failed.', code: timedOut ? 504 : 502 });
    }
  } finally {
    clearTimeout(timer);
    raw.off('close', disconnect);
    if (!raw.destroyed && !raw.writableEnded) raw.end();
  }
  return reply;
});

app.get<{ Params: { id: string } }>('/investigations/:id', async (request, reply) => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(request.params.id)) return reply.code(404).send({ message: 'Investigation not found.' });
  try {
    const report = await readFile(join(resultsDir, request.params.id, 'report.json'), 'utf8');
    return reply.type('application/json').send(report);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      try { return reply.type('application/json').send(await readFile(join(resultsDir, request.params.id, 'status.json'), 'utf8')); }
      catch (statusError) {
        if ((statusError as NodeJS.ErrnoException).code === 'ENOENT') return reply.code(404).send({ message: 'Investigation not found.' });
        throw statusError;
      }
    }
    throw error;
  }
});
