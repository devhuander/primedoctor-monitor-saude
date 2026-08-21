import tls from 'node:tls';
import dns from 'node:dns/promises';
import { CONFIG } from '../config.mjs';

/**
 * fetch com timeout, medição de tempo e captura de erro em vez de throw.
 * Nunca lança: sempre devolve um objeto descrevendo o que aconteceu.
 */
export async function timedFetch(url, options = {}) {
  const timeout = options.timeoutMs ?? CONFIG.timeouts.http;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const t0 = performance.now();
  try {
    const res = await fetch(url, {
      redirect: options.redirect ?? 'follow',
      method: options.method ?? 'GET',
      headers: options.headers,
      body: options.body,
      signal: controller.signal,
    });
    let body = null;
    let bytes = 0;
    if (options.readBody !== false) {
      const text = await res.text();
      bytes = Buffer.byteLength(text);
      body = options.maxBody === 0 ? null : text.slice(0, options.maxBody ?? 250_000);
    }
    const ms = Math.round(performance.now() - t0);
    return {
      ok: res.ok,
      status: res.status,
      ms,
      bytes,
      body,
      headers: Object.fromEntries(res.headers.entries()),
      url: res.url,
      error: null,
    };
  } catch (err) {
    const ms = Math.round(performance.now() - t0);
    const aborted = err?.name === 'AbortError';
    return {
      ok: false,
      status: 0,
      ms,
      bytes: 0,
      body: null,
      headers: {},
      url,
      error: aborted ? `timeout após ${timeout}ms` : describeError(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

export function describeError(err) {
  if (!err) return 'erro desconhecido';
  const cause = err.cause;
  const code = cause?.code || err.code;
  const map = {
    ENOTFOUND: 'DNS não resolveu o domínio',
    ECONNREFUSED: 'conexão recusada',
    ECONNRESET: 'conexão encerrada pelo servidor',
    ETIMEDOUT: 'tempo esgotado na conexão',
    EAI_AGAIN: 'falha temporária de DNS',
    CERT_HAS_EXPIRED: 'certificado TLS expirado',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'cadeia de certificados TLS inválida',
    DEPTH_ZERO_SELF_SIGNED_CERT: 'certificado TLS autoassinado',
  };
  if (code && map[code]) return map[code];
  const msg = cause?.message || err.message || String(err);
  return code ? `${code}: ${msg}` : msg;
}

/** Tempo de resolução DNS + IPs. */
export async function resolveDns(hostname) {
  const t0 = performance.now();
  try {
    const addrs = await dns.lookup(hostname, { all: true });
    return {
      ok: true,
      ms: Math.round(performance.now() - t0),
      addresses: addrs.map((a) => a.address).slice(0, 6),
      error: null,
    };
  } catch (err) {
    return { ok: false, ms: Math.round(performance.now() - t0), addresses: [], error: describeError(err) };
  }
}

/** Dados do certificado TLS: emissor e dias até expirar. */
export function inspectTls(hostname, port = 443) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* ignore */ }
      resolve(v);
    };
    const socket = tls.connect(
      { host: hostname, port, servername: hostname, timeout: 10000 },
      () => {
        const cert = socket.getPeerCertificate();
        const validTo = cert?.valid_to ? new Date(cert.valid_to) : null;
        const daysLeft = validTo ? Math.floor((validTo - Date.now()) / 86_400_000) : null;
        done({
          ok: socket.authorized || !!cert?.valid_to,
          ms: Math.round(performance.now() - t0),
          issuer: cert?.issuer?.O || cert?.issuer?.CN || null,
          subject: cert?.subject?.CN || null,
          validTo: validTo ? validTo.toISOString() : null,
          daysLeft,
          protocol: socket.getProtocol?.() || null,
          error: socket.authorized ? null : socket.authorizationError ? String(socket.authorizationError) : null,
        });
      },
    );
    socket.on('timeout', () => done({ ok: false, ms: 10000, daysLeft: null, error: 'timeout no handshake TLS' }));
    socket.on('error', (err) =>
      done({ ok: false, ms: Math.round(performance.now() - t0), daysLeft: null, error: describeError(err) }),
    );
  });
}

/** Identifica quem está servindo, a partir dos headers de resposta. */
export function identifyHost(headers = {}) {
  const h = {};
  for (const [k, v] of Object.entries(headers)) h[k.toLowerCase()] = v;
  const signals = [];
  if (h['cf-ray'] || (h['server'] || '').toLowerCase().includes('cloudflare')) signals.push('Cloudflare');
  if (h['x-vercel-id'] || (h['server'] || '').toLowerCase() === 'vercel') signals.push('Vercel');
  if (h['fly-request-id'] || (h['server'] || '').toLowerCase().startsWith('fly')) signals.push('Fly.io');
  if (h['x-served-by'] || h['x-cache']) signals.push('CDN com cache');
  if (Object.keys(h).some((k) => k.startsWith('x-lovable'))) signals.push('Lovable');
  if ((h['server'] || '').toLowerCase().includes('netlify') || h['x-nf-request-id']) signals.push('Netlify');
  return {
    server: h['server'] || null,
    via: h['via'] || null,
    cfRay: h['cf-ray'] || null,
    cacheStatus: h['cf-cache-status'] || h['x-cache'] || null,
    detected: signals.length ? [...new Set(signals)] : ['não identificado'],
  };
}
