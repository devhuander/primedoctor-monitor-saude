import { CONFIG, STATUS } from '../config.mjs';
import { timedFetch } from '../lib/http.mjs';

const MAP = {
  none: STATUS.OK,
  minor: STATUS.DEGRADED,
  major: STATUS.FAIL,
  critical: STATUS.FAIL,
  maintenance: STATUS.DEGRADED,
};

/**
 * Status oficial das plataformas de que o PrimeDoctor depende.
 * Serve para responder "o problema é meu ou do fornecedor?" — por isso é
 * informativo e NÃO entra no cálculo do status geral do sistema.
 */
export async function checkUpstreams() {
  const items = [];
  for (const up of CONFIG.upstreams) {
    const r = await timedFetch(up.url, { timeoutMs: 12000, maxBody: 4000 });
    if (!r.ok) {
      items.push({
        key: up.key,
        label: up.label,
        status: STATUS.UNKNOWN,
        latencyMs: r.ms,
        detail: 'página de status indisponível',
        meta: {},
      });
      continue;
    }
    let json = {};
    try { json = JSON.parse(r.body || '{}'); } catch { /* ignore */ }
    const indicator = json?.status?.indicator || 'unknown';
    items.push({
      key: up.key,
      label: up.label,
      status: MAP[indicator] ?? STATUS.UNKNOWN,
      latencyMs: r.ms,
      detail: json?.status?.description || indicator,
      meta: { indicator },
    });
  }

  const problems = items.filter((i) => i.status === STATUS.FAIL || i.status === STATUS.DEGRADED);
  const unknown = items.filter((i) => i.status === STATUS.UNKNOWN);
  let detail;
  if (problems.length) detail = `${problems.map((p) => p.label).join(', ')} relatando incidente`;
  else if (unknown.length === items.length) detail = 'não foi possível consultar as páginas de status';
  else if (unknown.length) detail = `nenhum incidente relatado · ${unknown.length} sem resposta`;
  else detail = 'nenhum incidente relatado';

  // A seção é informativa e não derruba o status geral do produto — mas não
  // pode ficar pregada em verde por construção: quando nenhuma página de
  // status responde, o sinal honesto é "indeterminado".
  const allUnknown = unknown.length === items.length && items.length > 0;

  return {
    key: 'upstream',
    label: 'Plataformas de terceiros',
    informational: true,
    status: allUnknown ? STATUS.UNKNOWN : problems.length ? STATUS.DEGRADED : STATUS.OK,
    latencyMs: null,
    items,
    detail,
    meta: {},
  };
}
