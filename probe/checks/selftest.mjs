import { CONFIG } from '../config.mjs';
import { timedFetch } from '../lib/http.mjs';

/**
 * Autoteste do próprio monitor, executado ANTES de julgar qualquer coisa.
 *
 * Sem isto, um runner do GitHub sem egresso de rede produz exatamente a mesma
 * saída de uma queda total do PrimeDoctor: tudo vermelho, incidente aberto,
 * alarme disparado. Foi reproduzido: 0,2s de execução e "FALHA DETECTADA" com
 * o sistema perfeitamente no ar.
 *
 * A regra: se NENHUM alvo de controle responde, o monitor não tem autoridade
 * para dizer que o sistema caiu. O veredito vira "indeterminado" e nada é
 * alarmado.
 */
export async function selfTest() {
  const results = [];
  for (const url of CONFIG.controlTargets) {
    const r = await timedFetch(url, { readBody: false, timeoutMs: 10000 });
    results.push({ url, ok: r.ok || (r.status > 0 && r.status < 500), ms: r.ms, error: r.error, status: r.status });
  }
  const reachable = results.filter((r) => r.ok);
  return {
    networkOk: reachable.length > 0,
    reachable: reachable.length,
    total: results.length,
    detail: reachable.length
      ? `${reachable.length}/${results.length} alvos de controle responderam`
      : 'nenhum alvo de controle respondeu — o runner do monitor está sem rede',
    targets: results.map((r) => ({ host: hostOf(r.url), ok: r.ok, ms: r.ms })),
  };
}

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return url; }
}
