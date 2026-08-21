import { CONFIG, STATUS, worstStatus, statusFromLatency } from '../config.mjs';
import { timedFetch } from '../lib/http.mjs';

const T = CONFIG.thresholds;

/**
 * Verifica se as edge functions críticas continuam publicadas.
 *
 * COMO ISTO FUNCIONA — e por que a versão ingênua mentia:
 *
 * O relay do Supabase valida o JWT ANTES de resolver o slug da função. No
 * `config.toml` do PrimeDoctor, 11 das 13 funções monitoradas têm
 * `verify_jwt = true`. Mandando só `apikey`, o gateway devolve 401 tanto para
 * função publicada quanto para função DELETADA — e a versão anterior traduzia
 * esse 401 para "publicada". Onze cartões verdes permanentes, independentes da
 * realidade.
 *
 * A correção tem três partes:
 *   1. mandar `Authorization: Bearer <anonKey>` (JWT anon válido passa o
 *      gateway), para que um slug inexistente devolva 404 de verdade;
 *   2. 401/403 NUNCA vira "ok" — vira "não verificável";
 *   3. um canário: um slug que não existe. Se ele parar de devolver 404, a
 *      técnica quebrou e a seção inteira se declara não confiável, em vez de
 *      continuar publicando verde.
 *
 * O que esta checagem prova: a função existe, está roteável e faz boot.
 * O que ela NÃO prova: que a lógica interna funciona. `OPTIONS` retorna no topo
 * do handler. Uma função com token expirado ou variável de ambiente faltando
 * responde o preflight e estoura em todo POST. Isso está documentado no README
 * como limitação conhecida — não venda o que a sonda não entrega.
 */
export async function checkEdgeFunctions() {
  const { url, anonKey } = CONFIG.supabase;

  const preflight = (slug) =>
    timedFetch(`${url}/functions/v1/${slug}`, {
      method: 'OPTIONS',
      headers: {
        apikey: anonKey,
        // Sem isto o gateway rejeita antes de saber se a função existe.
        Authorization: `Bearer ${anonKey}`,
        Origin: CONFIG.app.baseUrl,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization, content-type',
      },
      readBody: false,
      timeoutMs: CONFIG.timeouts.edge,
    });

  // ---- controle negativo, antes de qualquer conclusão ----
  const canary = await preflight(CONFIG.edge.canarySlug);
  const canaryValid = canary.status === 404;

  if (!canaryValid) {
    const why =
      canary.status === 0
        ? `o gateway não respondeu (${canary.error})`
        : `um slug inexistente devolveu HTTP ${canary.status} em vez de 404`;
    return {
      key: 'edge',
      label: 'Funções de borda (integrações)',
      status: STATUS.UNKNOWN,
      latencyMs: canary.ms,
      items: [
        {
          key: '__canary__',
          label: 'Autoteste da sonda (canário 404)',
          status: STATUS.UNKNOWN,
          latencyMs: canary.ms,
          detail: why,
          meta: { httpStatus: canary.status },
        },
      ],
      detail: `sonda não confiável — ${why}. As funções não foram verificadas nesta execução.`,
      meta: { canaryValid: false },
    };
  }

  // ---- verificação real ----
  const results = [];
  for (const fn of CONFIG.edge.functions) {
    const r = await preflight(fn.name);

    let status;
    let detail;
    if (r.status === 404) {
      status = STATUS.FAIL;
      detail = 'NÃO ENCONTRADA — a função sumiu do deploy';
    } else if (r.status === 0) {
      status = STATUS.UNKNOWN;
      detail = `sem resposta do gateway: ${r.error}`;
    } else if (r.status === 401 || r.status === 403) {
      // O gateway barrou antes de rotear: não dá para saber se a função existe.
      status = STATUS.UNKNOWN;
      detail = `não verificável — o gateway recusou antes de rotear (HTTP ${r.status})`;
    } else if (r.status >= 500) {
      status = STATUS.FAIL;
      detail = `a função existe mas falhou ao subir (HTTP ${r.status})`;
    } else {
      status = statusFromLatency(r.ms, T.edgeWarn, T.edgeFail);
      detail =
        status === STATUS.OK
          ? `publicada e roteável · HTTP ${r.status}`
          : `publicada, porém lenta para acordar · HTTP ${r.status}`;
    }

    results.push({
      key: fn.name,
      label: fn.label,
      critical: fn.critical,
      status,
      latencyMs: r.status === 0 ? null : r.ms,
      detail,
      meta: { httpStatus: r.status, cors: r.headers?.['access-control-allow-origin'] ?? null },
    });
  }

  results.unshift({
    key: '__canary__',
    label: 'Autoteste da sonda (canário 404)',
    critical: true,
    status: STATUS.OK,
    latencyMs: canary.ms,
    detail: 'slug inexistente devolveu 404 — a detecção está funcionando',
    meta: { httpStatus: 404 },
  });

  // Só as funções críticas definem o status da seção. Uma função não crítica
  // fora do ar aparece vermelha na lista, mas não tinge a página inteira nem
  // acorda ninguém de madrugada.
  const criticals = results.filter((r) => r.critical);
  const nonCriticalBad = results.filter((r) => !r.critical && r.status !== STATUS.OK);
  const criticalBad = criticals.filter((r) => r.status !== STATUS.OK);

  const parts = [];
  if (criticalBad.length) parts.push(`${criticalBad.length} crítica(s) com problema: ${criticalBad.map((b) => b.key).join(', ')}`);
  else parts.push(`${criticals.length - 1} função(ões) crítica(s) publicadas`);
  if (nonCriticalBad.length) parts.push(`${nonCriticalBad.length} não crítica(s) com problema`);

  const latencies = results.filter((r) => r.latencyMs != null).map((r) => r.latencyMs);

  return {
    key: 'edge',
    label: 'Funções de borda (integrações)',
    status: worstStatus(criticals.map((r) => r.status)),
    latencyMs: latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null,
    items: results,
    detail: parts.join(' · '),
    meta: { canaryValid: true },
  };
}
