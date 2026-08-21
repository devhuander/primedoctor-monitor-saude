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
    if (options.readBody === false) {
      // Sem drenar nem cancelar, o undici segura o socket até o GC.
      await res.body?.cancel().catch(() => {});
    } else {
      const text = await res.text();
      bytes = Buffer.byteLength(text);
      body = options.maxBody === 0 ? null : text.slice(0, options.maxBody ?? 250_000);
    }
    const ms = Math.round(performance.now() - t0);
    return {
      ok: res.ok,
      status: res.status,
      ms,
      // Com readBody:false o tempo medido é só o TTFB, não o download completo.
      measures: options.readBody === false ? 'ttfb' : 'total',
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
      measures: 'erro',
      bytes: 0,
      body: null,
      headers: {},
      url,
      error: aborted ? `tempo esgotado após ${timeout}ms` : describeError(err),
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
    ERR_TLS_CERT_ALTNAME_INVALID: 'certificado TLS não cobre este domínio',
  };
  if (code && map[code]) return map[code];
  const msg = cause?.message || err.message || String(err);
  return code ? `${code}: ${msg}` : String(msg).slice(0, 200);
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

/**
 * Inspeciona o certificado TLS.
 *
 * `ok` é EXATAMENTE `socket.authorized`. A versão anterior aceitava
 * "tem data de validade" como suficiente — o que aprovava certificado emitido
 * para outro domínio, cadeia não confiável e MITM, enquanto todo navegador
 * mostrava tela de interstício.
 */
export function inspectTls(hostname, port = 443) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      try { socket.destroy(); } catch { /* ignore */ }
      resolve({ ...v, ms: v.ms ?? Math.round(performance.now() - t0) });
    };

    const deadline = setTimeout(
      () => done({ ok: false, daysLeft: null, error: 'tempo esgotado no handshake TLS' }),
      12000,
    );

    const socket = tls.connect({ host: hostname, port, servername: hostname, timeout: 12000 }, () => {
      const cert = socket.getPeerCertificate();
      const validTo = cert?.valid_to ? new Date(cert.valid_to) : null;
      const daysLeft = validTo && !Number.isNaN(+validTo)
        ? Math.floor((validTo - Date.now()) / 86_400_000)
        : null;

      // Confere também que o certificado cobre ESTE hostname.
      let identityError = null;
      try {
        const r = tls.checkServerIdentity(hostname, cert);
        if (r) identityError = 'certificado não cobre este domínio';
      } catch { identityError = 'não foi possível validar a identidade do certificado'; }

      const authorized = socket.authorized && !identityError;
      done({
        ok: authorized,
        issuer: cert?.issuer?.O || cert?.issuer?.CN || null,
        subject: cert?.subject?.CN || null,
        validTo: validTo && !Number.isNaN(+validTo) ? validTo.toISOString() : null,
        daysLeft,
        protocol: socket.getProtocol?.() || null,
        error: authorized
          ? null
          : identityError || String(socket.authorizationError || 'certificado não confiável'),
      });
    });

    socket.on('timeout', () => done({ ok: false, daysLeft: null, error: 'conexão TLS ociosa (timeout)' }));
    socket.on('error', (err) => done({ ok: false, daysLeft: null, error: describeError(err) }));
  });
}

/**
 * Avalia o transporte de uma URL e devolve um item pronto.
 *
 * Regras deliberadas:
 *  - https  → inspeciona o certificado de verdade;
 *  - http em localhost → é teste local, não emite item;
 *  - http em qualquer outro host → FALHA. Servir a aplicação sem HTTPS é um
 *    problema de segurança, não um detalhe de configuração.
 */
export async function checkTransport({ url, key, label, thresholds }) {
  const parsed = new URL(url);
  const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(parsed.hostname);

  if (parsed.protocol !== 'https:') {
    if (isLocal) return null;
    return {
      key, label,
      status: 'fail',
      latencyMs: null,
      detail: 'o endereço está configurado em HTTP, sem TLS — tráfego trafega em texto claro',
      meta: {},
    };
  }

  const res = await inspectTls(parsed.hostname, parsed.port ? Number(parsed.port) : 443);
  let status = 'ok';
  if (!res.ok) status = 'fail';
  else if (res.daysLeft != null && res.daysLeft <= thresholds.tlsExpiryFailDays) status = 'fail';
  else if (res.daysLeft != null && res.daysLeft <= thresholds.tlsExpiryWarnDays) status = 'degraded';

  return {
    key, label, status,
    latencyMs: res.ms,
    detail: res.ok
      ? `válido · expira em ${res.daysLeft} dia(s) · ${res.issuer || 'emissor desconhecido'}`
      : res.error,
    meta: { daysLeft: res.daysLeft, issuer: res.issuer, protocol: res.protocol, validTo: res.validTo },
  };
}

/** Identifica quem está servindo, a partir dos headers de resposta. */
export function identifyHost(headers = {}) {
  const h = {};
  for (const [k, v] of Object.entries(headers)) h[k.toLowerCase()] = v;
  const server = (h['server'] || '').toLowerCase();
  const signals = [];
  if (h['cf-ray'] || server.includes('cloudflare')) signals.push('Cloudflare');
  if (h['x-vercel-id'] || server === 'vercel') signals.push('Vercel');
  if (h['fly-request-id'] || server.startsWith('fly')) signals.push('Fly.io');
  if (Object.keys(h).some((k) => k.startsWith('x-lovable'))) signals.push('Lovable');
  if (server.includes('netlify') || h['x-nf-request-id']) signals.push('Netlify');
  if (!signals.length && (h['x-served-by'] || h['x-cache'])) signals.push('CDN com cache');
  return {
    server: h['server'] || null,
    via: h['via'] || null,
    cfRay: h['cf-ray'] || null,
    cacheStatus: h['cf-cache-status'] || h['x-cache'] || null,
    detected: signals.length ? [...new Set(signals)] : ['host não identificado'],
  };
}
