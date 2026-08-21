import { CONFIG, STATUS, worstStatus, statusFromLatency } from '../config.mjs';
import { timedFetch, resolveDns, inspectTls, identifyHost } from '../lib/http.mjs';

const T = CONFIG.thresholds;

/**
 * Saúde da hospedagem do front-end (onde o app está publicado).
 * Roda no runner do GitHub Actions, sem CORS no caminho, então enxerga
 * status HTTP reais — coisa que uma página estática no navegador não consegue.
 */
export async function checkFrontend() {
  const base = CONFIG.app.baseUrl;
  const hostname = new URL(base).hostname;
  const items = [];

  // --- DNS ---
  const dnsRes = await resolveDns(hostname);
  items.push({
    key: 'dns',
    label: 'Resolução DNS',
    status: dnsRes.ok ? statusFromLatency(dnsRes.ms, 400, 2000) : STATUS.FAIL,
    latencyMs: dnsRes.ms,
    detail: dnsRes.ok ? `${dnsRes.addresses.length} endereço(s)` : dnsRes.error,
    meta: { addresses: dnsRes.addresses },
  });

  // --- TLS ---
  const tlsRes = await inspectTls(hostname);
  let tlsStatus = STATUS.OK;
  if (!tlsRes.ok) tlsStatus = STATUS.FAIL;
  else if (tlsRes.daysLeft != null && tlsRes.daysLeft <= T.tlsExpiryFailDays) tlsStatus = STATUS.FAIL;
  else if (tlsRes.daysLeft != null && tlsRes.daysLeft <= T.tlsExpiryWarnDays) tlsStatus = STATUS.DEGRADED;
  items.push({
    key: 'tls',
    label: 'Certificado TLS',
    status: tlsStatus,
    latencyMs: tlsRes.ms,
    detail: tlsRes.ok
      ? `expira em ${tlsRes.daysLeft} dia(s) · ${tlsRes.issuer || 'emissor desconhecido'}`
      : tlsRes.error,
    meta: { daysLeft: tlsRes.daysLeft, issuer: tlsRes.issuer, protocol: tlsRes.protocol, validTo: tlsRes.validTo },
  });

  // --- Documento raiz ---
  const root = await timedFetch(base + '/', { headers: { 'User-Agent': ua() } });
  const hostInfo = identifyHost(root.headers);
  const html = root.body || '';
  const hasRoot = /<div\s+id=["']root["']/i.test(html);
  const title = (html.match(/<title>([^<]*)<\/title>/i) || [])[1]?.trim() || null;

  let rootStatus;
  let rootDetail;
  if (!root.ok) {
    rootStatus = STATUS.FAIL;
    rootDetail = root.error ? root.error : `HTTP ${root.status}`;
  } else if (!hasRoot) {
    rootStatus = STATUS.FAIL;
    rootDetail = 'HTTP 200 mas o HTML não contém o ponto de montagem do app (#root)';
  } else {
    rootStatus = statusFromLatency(root.ms, T.httpWarn, T.httpFail);
    rootDetail = `HTTP 200 · ${formatBytes(root.bytes)} · ${hostInfo.detected.join(', ')}`;
  }
  items.push({
    key: 'document',
    label: 'Documento HTML',
    status: rootStatus,
    latencyMs: root.ms,
    detail: rootDetail,
    meta: { title, bytes: root.bytes, host: hostInfo },
  });

  // Se o documento nem carregou, as checagens seguintes não são verificáveis.
  // Reportá-las como "falha" seria ruído: a causa raiz já está acima.
  const documentReachable = root.status > 0;

  // --- Bundles gerados pelo build (JS/CSS) ---
  const assetUrls = documentReachable ? extractBuiltAssets(html, base) : [];
  const assetResults = [];
  for (const url of assetUrls.slice(0, 8)) {
    const r = await timedFetch(url, { method: 'GET', readBody: false, headers: { 'User-Agent': ua() } });
    assetResults.push({
      url: url.replace(base, ''),
      status: r.status,
      ms: r.ms,
      ok: r.ok,
      error: r.error,
      etag: r.headers?.etag || null,
    });
  }
  const brokenAssets = assetResults.filter((a) => !a.ok);
  items.push({
    key: 'bundles',
    label: 'Bundles do build (JS/CSS)',
    status: !documentReachable
      ? STATUS.UNKNOWN
      : assetResults.length === 0
        ? STATUS.DEGRADED
        : brokenAssets.length > 0
          ? STATUS.FAIL
          : statusFromLatency(Math.max(...assetResults.map((a) => a.ms)), T.httpWarn, T.httpFail),
    latencyMs: assetResults.length ? Math.max(...assetResults.map((a) => a.ms)) : null,
    detail: !documentReachable
      ? 'não verificável — o documento HTML não chegou a carregar'
      : assetResults.length === 0
        ? 'nenhum bundle referenciado no HTML (build pode não ter sido aplicado)'
        : brokenAssets.length > 0
          ? `${brokenAssets.length} de ${assetResults.length} bundle(s) não carregaram`
          : `${assetResults.length} bundle(s) OK`,
    meta: { assets: assetResults, buildFingerprint: fingerprint(assetUrls) },
  });

  // --- Assets estáticos ---
  const staticResults = [];
  if (documentReachable) {
    for (const path of CONFIG.app.staticAssets) {
      const r = await timedFetch(base + path, { readBody: false, headers: { 'User-Agent': ua() } });
      staticResults.push({ path, status: r.status, ms: r.ms, ok: r.ok, error: r.error });
    }
  }
  const brokenStatic = staticResults.filter((s) => !s.ok);
  items.push({
    key: 'static',
    label: 'Arquivos estáticos (manifest, favicon, robots)',
    status: !documentReachable
      ? STATUS.UNKNOWN
      : brokenStatic.length === 0
        ? STATUS.OK
        : brokenStatic.length === staticResults.length
          ? STATUS.FAIL
          : STATUS.DEGRADED,
    latencyMs: staticResults.length ? Math.round(avg(staticResults.map((s) => s.ms))) : null,
    detail: !documentReachable
      ? 'não verificável — o servidor não respondeu'
      : brokenStatic.length === 0
        ? `${staticResults.length} arquivo(s) OK`
        : `falhou: ${brokenStatic.map((s) => s.path).join(', ')}`,
    meta: { files: staticResults },
  });

  // --- Fallback de SPA ---
  const spa = documentReachable
    ? await timedFetch(base + CONFIG.app.spaFallbackRoute, { headers: { 'User-Agent': ua() } })
    : null;
  const spaOk = !!spa && spa.status === 200 && /<div\s+id=["']root["']/i.test(spa.body || '');
  items.push({
    key: 'spa-fallback',
    label: 'Roteamento SPA (deep link)',
    status: !documentReachable ? STATUS.UNKNOWN : spaOk ? STATUS.OK : STATUS.DEGRADED,
    latencyMs: spa?.ms ?? null,
    detail: !documentReachable
      ? 'não verificável — o servidor não respondeu'
      : spaOk
        ? 'rotas internas devolvem o app corretamente'
        : spa.status > 0
          ? `rota profunda devolveu HTTP ${spa.status} — links diretos podem quebrar`
          : `rota profunda não respondeu: ${spa.error}`,
    meta: {},
  });

  return {
    key: 'frontend',
    label: 'Hospedagem e front-end',
    status: worstStatus(items.map((i) => i.status)),
    latencyMs: root.ms,
    items,
    meta: { host: hostInfo, url: base },
  };
}

function extractBuiltAssets(html, base) {
  const urls = new Set();
  const re = /(?:src|href)=["']([^"']+\.(?:js|css)(?:\?[^"']*)?)["']/gi;
  let m;
  while ((m = re.exec(html))) {
    const raw = m[1];
    if (raw.startsWith('http') && !raw.startsWith(base)) continue; // ignora CDN de terceiros
    try {
      urls.add(new URL(raw, base).toString());
    } catch { /* ignore */ }
  }
  return [...urls];
}

function fingerprint(urls) {
  // O nome dos bundles muda a cada build; serve para detectar novo deploy.
  const names = urls.map((u) => u.split('/').pop()).sort();
  return names.join('|').slice(0, 300) || null;
}

function ua() {
  return 'PrimeDoctorHealthMonitor/1.0 (+https://github.com/devhuander/primedoctor-monitor-saude)';
}

function avg(a) {
  return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
}

function formatBytes(n) {
  if (!n) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
