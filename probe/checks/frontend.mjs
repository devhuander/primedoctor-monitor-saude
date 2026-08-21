import { CONFIG, STATUS, worstStatus, statusFromLatency } from '../config.mjs';
import { timedFetch, resolveDns, inspectTls, identifyHost, checkTransport } from '../lib/http.mjs';
import { safeUrl } from '../lib/sanitize.mjs';

const T = CONFIG.thresholds;
const UA = 'PrimeDoctorHealthMonitor/1.0 (+https://github.com/devhuander/primedoctor-monitor-saude)';

/**
 * Saúde da hospedagem do front-end.
 *
 * Roda no runner do GitHub Actions, sem CORS no caminho, então enxerga status
 * HTTP reais — coisa que uma página estática no navegador não consegue.
 *
 * Supressão de cascata: se o documento nem chega, as checagens dependentes
 * viram "não verificável" em vez de gerar uma parede de vermelho que esconde
 * a causa raiz.
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
    status: dnsRes.ok ? statusFromLatency(dnsRes.ms, 500, 3000) : STATUS.FAIL,
    latencyMs: dnsRes.ms,
    detail: dnsRes.ok ? `${dnsRes.addresses.length} endereço(s) · ${hostname}` : dnsRes.error,
    meta: { addresses: dnsRes.addresses },
  });

  // --- TLS ---
  const tlsItem = await checkTransport({ url: base, key: 'tls', label: 'Certificado TLS', thresholds: T });
  if (tlsItem) items.push(tlsItem);

  // --- Documento raiz ---
  const root = await timedFetch(base + '/', { headers: { 'User-Agent': UA } });
  const hostInfo = identifyHost(root.headers);
  const html = root.body || '';
  const hasRoot = /<div\s+id=["']root["']/i.test(html);
  const assetUrls = root.status > 0 ? extractBuiltAssets(html, base) : [];
  const buildFingerprint = fingerprint(assetUrls);
  const reachable = root.status > 0;

  let rootStatus;
  let rootDetail;
  if (!reachable) {
    rootStatus = STATUS.FAIL;
    rootDetail = root.error;
  } else if (!root.ok) {
    rootStatus = STATUS.FAIL;
    rootDetail = `o servidor devolveu HTTP ${root.status}`;
  } else if (!hasRoot) {
    rootStatus = STATUS.FAIL;
    rootDetail = 'HTTP 200 mas o HTML não contém o ponto de montagem do app (#root)';
  } else if (!buildFingerprint) {
    rootStatus = STATUS.FAIL;
    rootDetail = 'HTML servido sem nenhum bundle do build referenciado — deploy provavelmente quebrado';
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
    meta: {
      title: (html.match(/<title>([^<]*)<\/title>/i) || [])[1]?.trim() || null,
      bytes: root.bytes,
      host: hostInfo,
      buildFingerprint,
    },
  });

  // --- Bundles gerados pelo build ---
  const assetResults = [];
  for (const url of assetUrls.slice(0, 8)) {
    const r = await timedFetch(url, { readBody: false, headers: { 'User-Agent': UA } });
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
    status: !reachable
      ? STATUS.UNKNOWN
      : assetResults.length === 0
        ? STATUS.FAIL
        : brokenAssets.length > 0
          ? STATUS.FAIL
          : statusFromLatency(Math.max(...assetResults.map((a) => a.ms)), T.httpWarn, T.httpFail),
    latencyMs: assetResults.length ? Math.max(...assetResults.map((a) => a.ms)) : null,
    detail: !reachable
      ? 'não verificável — o documento HTML não chegou a carregar'
      : assetResults.length === 0
        ? 'nenhum bundle referenciado no HTML'
        : brokenAssets.length > 0
          ? `${brokenAssets.length} de ${assetResults.length} bundle(s) não carregaram`
          : `${assetResults.length} bundle(s) OK`,
    meta: { assets: assetResults, buildFingerprint },
  });

  // --- Assets estáticos ---
  const staticResults = [];
  if (reachable) {
    for (const path of CONFIG.app.staticAssets) {
      const r = await timedFetch(base + path, { readBody: false, headers: { 'User-Agent': UA } });
      staticResults.push({ path, status: r.status, ms: r.ms, ok: r.ok, error: r.error });
    }
  }
  const brokenStatic = staticResults.filter((s) => !s.ok);
  items.push({
    key: 'static',
    label: 'Arquivos estáticos (manifest, favicon, robots)',
    status: !reachable
      ? STATUS.UNKNOWN
      : brokenStatic.length === 0
        ? STATUS.OK
        : brokenStatic.length === staticResults.length
          ? STATUS.FAIL
          : STATUS.DEGRADED,
    latencyMs: staticResults.length ? Math.round(avg(staticResults.map((s) => s.ms))) : null,
    detail: !reachable
      ? 'não verificável — o servidor não respondeu'
      : brokenStatic.length === 0
        ? `${staticResults.length} arquivo(s) OK`
        : `falhou: ${brokenStatic.map((s) => s.path).join(', ')}`,
    meta: { files: staticResults },
  });

  // --- Fallback de SPA ---
  const spa = reachable ? await timedFetch(base + CONFIG.app.spaFallbackRoute, { headers: { 'User-Agent': UA } }) : null;
  const spaOk = !!spa && spa.status === 200 && /<div\s+id=["']root["']/i.test(spa.body || '');
  items.push({
    key: 'spa-fallback',
    label: 'Roteamento SPA (link direto)',
    status: !reachable ? STATUS.UNKNOWN : spaOk ? STATUS.OK : STATUS.DEGRADED,
    latencyMs: spa?.ms ?? null,
    detail: !reachable
      ? 'não verificável — o servidor não respondeu'
      : spaOk
        ? 'rotas internas devolvem o app corretamente'
        : spa.status > 0
          ? `rota profunda devolveu HTTP ${spa.status} — links diretos podem quebrar`
          : `rota profunda não respondeu: ${spa.error}`,
    meta: {},
  });

  // --- Domínios alternativos ---
  for (const alt of CONFIG.app.alternateUrls) {
    items.push(await checkAlternate(alt, buildFingerprint));
  }

  return {
    key: 'frontend',
    label: 'Hospedagem e front-end',
    status: worstStatus(items.map((i) => i.status)),
    latencyMs: root.ms,
    items,
    meta: { host: hostInfo, url: base, buildFingerprint },
  };
}

/**
 * Sonda leve para um domínio alternativo do mesmo app.
 * Além de estar no ar, ele deve servir o MESMO build do domínio principal —
 * divergência aí significa deploy pela metade ou cache preso.
 */
async function checkAlternate(url, primaryFingerprint) {
  const key = `alt:${new URL(url).hostname}`;
  const label = `Domínio alternativo (${new URL(url).hostname})`;
  const hostname = new URL(url).hostname;

  const dnsRes = await resolveDns(hostname);
  if (!dnsRes.ok) {
    return { key, label, status: STATUS.FAIL, latencyMs: dnsRes.ms, detail: `DNS: ${dnsRes.error}`, meta: {} };
  }

  const tlsItem = await checkTransport({ url, key, label, thresholds: T });
  if (tlsItem && tlsItem.status === STATUS.FAIL) {
    return { ...tlsItem, detail: `TLS: ${tlsItem.detail}` };
  }
  const tlsDaysLeft = tlsItem?.meta?.daysLeft ?? null;

  const r = await timedFetch(url + '/', { headers: { 'User-Agent': UA } });
  if (r.status === 0) {
    return { key, label, status: STATUS.FAIL, latencyMs: r.ms, detail: r.error, meta: {} };
  }
  if (!r.ok) {
    return { key, label, status: STATUS.FAIL, latencyMs: r.ms, detail: `HTTP ${r.status}`, meta: {} };
  }

  const fp = fingerprint(extractBuiltAssets(r.body || '', url));
  const sameBuild = !primaryFingerprint || !fp || fp === primaryFingerprint;

  return {
    key,
    label,
    status: !fp ? STATUS.FAIL : sameBuild ? statusFromLatency(r.ms, T.httpWarn, T.httpFail) : STATUS.DEGRADED,
    latencyMs: r.ms,
    detail: !fp
      ? 'no ar, mas sem bundle do build no HTML'
      : sameBuild
        ? `no ar${tlsDaysLeft != null ? ` · TLS expira em ${tlsDaysLeft} dia(s)` : ''} · mesmo build do domínio principal`
        : 'no ar, porém servindo um BUILD DIFERENTE do domínio principal — deploy pela metade ou cache preso',
    meta: { buildFingerprint: fp, tlsDaysLeft, url: safeUrl(url) },
  };
}

function extractBuiltAssets(html, base) {
  const urls = new Set();
  const re = /(?:src|href)=["']([^"']+\.(?:js|css)(?:\?[^"']*)?)["']/gi;
  let m;
  while ((m = re.exec(html))) {
    const raw = m[1];
    if (/^https?:\/\//i.test(raw) && !raw.startsWith(base)) continue; // ignora CDN de terceiros
    try { urls.add(new URL(raw, base).toString()); } catch { /* ignore */ }
  }
  return [...urls];
}

/**
 * O nome dos bundles muda a cada build (hash do Vite). É o campo mais útil
 * durante um incidente: "o bundle mudou logo antes de ficar vermelho?".
 */
function fingerprint(urls) {
  const names = urls
    .map((u) => { try { return new URL(u).pathname.split('/').pop(); } catch { return null; } })
    .filter(Boolean)
    .sort();
  return names.length ? names.join('|').slice(0, 300) : null;
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
