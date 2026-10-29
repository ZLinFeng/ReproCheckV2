'use strict';

const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const os = require('node:os');
const fs = require('node:fs');

const blocked = new net.BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blocked.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]]) {
  blocked.addSubnet(network, prefix, 'ipv6');
}
const globalV6 = new net.BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
for (const address of JSON.parse(process.env.HOST_ADDRESSES || '[]')) {
  const family = net.isIP(address);
  if (family) blocked.addAddress(address, family === 4 ? 'ipv4' : 'ipv6');
}

function isPublic(address) {
  const family = net.isIP(address);
  if (family === 4) return !blocked.check(address, 'ipv4');
  if (family === 6) return globalV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
  return false;
}

function resolvePublic(host, type) {
  return new Promise((resolve, reject) => {
    const request = https.get({ host: '1.1.1.1', servername: 'cloudflare-dns.com', path: `/dns-query?name=${encodeURIComponent(host)}&type=${type}`,
      headers: { accept: 'application/dns-json' }, timeout: 5000 }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; if (body.length > 65536) request.destroy(); });
      response.on('error', reject);
      response.on('aborted', () => reject(new Error('DNS response aborted')));
      response.on('end', () => {
        try {
          const result = JSON.parse(body);
          if (response.statusCode !== 200 || ![0, 3].includes(result.Status) || result.TC) throw new Error('DNS lookup failed');
          resolve((result.Answer || []).filter((entry) => entry.type === type && net.isIP(entry.data))
            .map((entry) => ({ address: entry.data, family: net.isIP(entry.data) })));
        } catch (error) { reject(error); }
      });
    });
    request.on('timeout', () => request.destroy(new Error('DNS timeout')));
    request.on('error', reject);
  });
}

async function resolveTarget(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '');
  const addresses = net.isIP(host) ? [{ address: host, family: net.isIP(host) }]
    : (await Promise.all([resolvePublic(host, 1), resolvePublic(host, 28)])).flat();
  if (!addresses.length || addresses.some(({ address }) => !isPublic(address))) throw new Error('destination denied');
  return addresses[0];
}

function parseTarget(value, defaultPort) {
  const url = new URL(value);
  if (url.username || url.password || !url.hostname) throw new Error('invalid target');
  const port = Number(url.port || defaultPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid port');
  return { url, port };
}

function createProxy(model, targetResolver = resolveTarget) {
  const server = http.createServer(async (request, response) => {
    try {
      if (request.url === '/reprocheck-model/v1/chat/completions') {
        if (!model || request.method !== 'POST') { response.writeHead(403); response.end(); return; }
        let body = '';
        request.setEncoding('utf8');
        for await (const chunk of request) {
          body += chunk;
          if (Buffer.byteLength(body) > 2_000_000) throw new Error('request too large');
        }
        const data = JSON.parse(body);
        if (!data || typeof data !== 'object' || Array.isArray(data) || data.model !== model.model) throw new Error('model denied');
        const base = new URL(model.baseUrl);
        if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) throw new Error('invalid model endpoint');
        const target = await targetResolver(base.hostname);
        const upstream = https.request({ hostname: target.address, family: target.family, servername: base.hostname,
          port: base.port || 443, method: 'POST', path: `${base.pathname.replace(/\/$/, '')}/chat/completions`,
          headers: { host: base.host, 'content-type': 'application/json', authorization: `Bearer ${model.key}` }, timeout: 180000 }, (result) => {
          response.writeHead(result.statusCode || 502, { 'content-type': result.headers['content-type'] || 'application/json' });
          result.pipe(response);
        });
        upstream.on('timeout', () => upstream.destroy());
        upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
        response.on('close', () => upstream.destroy());
        upstream.end(body);
        return;
      }
      const { url, port } = parseTarget(request.url, 80);
      if (url.protocol !== 'http:') throw new Error('unsupported protocol');
      const target = await resolveTarget(url.hostname);
      const headers = { ...request.headers, host: url.host };
      delete headers['proxy-authorization'];
      delete headers['proxy-connection'];
      const upstream = http.request({ hostname: target.address, family: target.family, port, method: request.method,
        path: `${url.pathname}${url.search}`, headers, timeout: 30000 }, (result) => {
        response.writeHead(result.statusCode || 502, result.headers);
        result.pipe(response);
      });
      upstream.on('timeout', () => upstream.destroy());
      upstream.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
      request.pipe(upstream);
    } catch { response.writeHead(403); response.end('destination denied'); }
  });
  server.on('connect', async (request, client, head) => {
    client.on('error', () => {});
    try {
      const { url, port } = parseTarget(`http://${request.url}`, 443);
      if (url.pathname !== '/' || url.search || url.hash) throw new Error('invalid target');
      const target = await resolveTarget(url.hostname);
      if (client.destroyed) return;
      const upstream = net.connect({ host: target.address, family: target.family, port });
      upstream.setTimeout(30000, () => upstream.destroy());
      upstream.on('error', () => client.destroy());
      client.on('close', () => upstream.destroy());
      upstream.once('connect', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
    } catch { client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); }
  });
  server.headersTimeout = 10000;
  server.requestTimeout = 30000;
  server.maxConnections = 64;
  return server;
}

if (require.main === module) {
  const address = (os.networkInterfaces().eth0 || []).find((item) => item.family === 'IPv4' && !item.internal)?.address;
  if (!address) throw new Error('isolated interface unavailable');
  const model = process.env.MODEL_CONFIG ? JSON.parse(fs.readFileSync(process.env.MODEL_CONFIG, 'utf8')) : undefined;
  createProxy(model).listen(3128, address);
}

module.exports = { isPublic, resolveTarget, createProxy };
