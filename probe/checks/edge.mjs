import { CONFIG, STATUS, worstStatus, statusFromLatency } from '../config.mjs';
import { timedFetch } from '../lib/http.mjs';

const T = CONFIG.thresholds;

/**
 * Verifica se as edge functions críticas continuam publicadas e respondendo.
 *
 * Usa OPTIONS (preflight CORS): a função é acordada e responde os headers,
 * mas a lógica de negócio NÃO é executada. Isso torna a checagem segura de
 * rodar de hora em hora — não dispara mensagem de WhatsApp, não grava lead,
 * não consome crédito de IA.
 *
 * Um 404 aqui significa que a função sumiu do deploy — exatamente o tipo de
 * regressão silenciosa que derruba webhook sem ninguém perceber.
 */
export async function checkEdgeFunctions() {
  const { url, anonKey } = CONFIG.supabase;
  const results = [];

  for (const fn of CONFIG.edgeFunctions) {
    const r = await timedFetch(`${url}/functions/v1/${fn.name}`, {
      method: 'OPTIONS',
      headers: {
        apikey: anonKey,
        Origin: CONFIG.app.baseUrl,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization, content-type',
      },
      readBody: false,
      timeoutMs: 15000,
    });

    let status;
    let detail;
    if (r.status === 0) {
      status = STATUS.FAIL;
      detail = r.error || 'sem resposta';
    } else if (r.status === 404) {
      status = STATUS.FAIL;
      detail = 'função não encontrada — provavelmente removida do deploy';
    } else if (r.status >= 500) {
      status = STATUS.FAIL;
      detail = `erro do servidor (HTTP ${r.status})`;
    } else if (r.status === 401 || r.status === 403) {
      // Preflight bloqueado por JWT: a função existe e o gateway respondeu.
      status = STATUS.OK;
      detail = `publicada (preflight exige JWT · HTTP ${r.status})`;
    } else {
      status = statusFromLatency(r.ms, T.edgeWarn, T.edgeFail);
      detail = `publicada · HTTP ${r.status}${status !== STATUS.OK ? ' · lenta' : ''}`;
    }

    results.push({
      key: fn.name,
      label: fn.label,
      critical: fn.critical,
      status,
      latencyMs: r.ms,
      detail,
      meta: { httpStatus: r.status, cors: r.headers?.['access-control-allow-origin'] ?? null },
    });
  }

  // Funções não críticas com problema rebaixam para "degradado", não derrubam tudo.
  const effective = results.map((r) =>
    r.critical || r.status === STATUS.OK ? r.status : r.status === STATUS.FAIL ? STATUS.DEGRADED : r.status,
  );

  const broken = results.filter((r) => r.status !== STATUS.OK);
  const latencies = results.filter((r) => r.latencyMs != null).map((r) => r.latencyMs);

  return {
    key: 'edge',
    label: 'Funções de borda (integrações)',
    status: worstStatus(effective),
    latencyMs: latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null,
    items: results,
    meta: {},
    detail: broken.length
      ? `${broken.length} de ${results.length} com problema: ${broken.map((b) => b.key).join(', ')}`
      : `${results.length} funções publicadas`,
  };
}
