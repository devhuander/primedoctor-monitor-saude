import WebSocket from 'ws';
import { CONFIG, STATUS, worstStatus, statusFromLatency } from '../config.mjs';
import { timedFetch, describeError, checkTransport } from '../lib/http.mjs';
import { scrub } from '../lib/sanitize.mjs';

const T = CONFIG.thresholds;

/**
 * Saúde do backend: TLS, Auth, PostgREST, Postgres (via consultas reais com
 * asserção de linhas), Realtime e Storage.
 *
 * Nunca gravamos conteúdo de linhas — apenas latência, contagem e sucesso/erro.
 */
export async function checkBackend(session) {
  const { url, anonKey } = CONFIG.supabase;
  const items = [];
  const authed = !!session?.accessToken;
  const bearer = authed ? session.accessToken : anonKey;
  const baseHeaders = { apikey: anonKey, Authorization: `Bearer ${bearer}` };

  // --- TLS do próprio Supabase (o front-end não é o único endpoint que importa) ---
  const supaTls = await checkTransport({
    url, key: 'supabase-tls', label: 'Certificado TLS do Supabase', thresholds: T,
  });
  if (supaTls) items.push(supaTls);

  // --- GoTrue (autenticação) ---
  const auth = await timedFetch(`${url}/auth/v1/health`, { headers: { apikey: anonKey }, maxBody: 1000 });
  let authVersion = null;
  try { authVersion = JSON.parse(auth.body || '{}').version || null; } catch { /* ignore */ }
  items.push({
    key: 'auth',
    label: 'Serviço de autenticação',
    status: auth.ok ? statusFromLatency(auth.ms, T.dbWarn, T.dbFail) : STATUS.FAIL,
    latencyMs: auth.ms,
    detail: auth.ok ? `no ar${authVersion ? ` · ${authVersion}` : ''}` : auth.error || `HTTP ${auth.status}`,
    meta: { version: authVersion },
  });

  // --- PostgREST ---
  const rest = await timedFetch(`${url}/rest/v1/`, { headers: baseHeaders, readBody: false });
  items.push({
    key: 'postgrest',
    label: 'API do banco (PostgREST)',
    status: rest.ok ? statusFromLatency(rest.ms, T.dbWarn, T.dbFail) : STATUS.FAIL,
    latencyMs: rest.ms,
    detail: rest.ok ? 'no ar' : rest.error || `HTTP ${rest.status}`,
    meta: {},
  });

  // --- Healthcheck oficial do PrimeDoctor (consulta com service role) ---
  const health = await timedFetch(`${url}/functions/v1/system-health`, {
    headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` },
    maxBody: 2000,
  });
  let healthJson = {};
  try { healthJson = JSON.parse(health.body || '{}'); } catch { /* ignore */ }
  const dbOk = healthJson.db === 'ok';
  items.push({
    key: 'system-health',
    label: 'Healthcheck do PrimeDoctor (banco)',
    status: health.ok && dbOk ? statusFromLatency(health.ms, T.dbWarn, T.dbFail) : health.status === 0 ? STATUS.UNKNOWN : STATUS.FAIL,
    latencyMs: health.ms,
    detail: health.ok
      ? dbOk
        ? `banco respondendo em ${healthJson.latency_ms ?? '?'}ms`
        : `banco com falha: ${scrub(healthJson.db_error) || 'sem detalhe'}`
      : health.error || `HTTP ${health.status}`,
    meta: { dbLatencyMs: healthJson.latency_ms ?? null },
  });

  // --- Consultas reais + asserção de RLS ---
  items.push(await checkDatabase(url, baseHeaders, authed, session));

  // --- Realtime ---
  const realtime = await checkRealtime(url, anonKey);
  items.push({
    key: 'realtime',
    label: 'Realtime (tempo real)',
    status: realtime.ok ? statusFromLatency(realtime.ms, 2500, 8000) : STATUS.FAIL,
    latencyMs: realtime.ms,
    detail: realtime.ok ? 'websocket conectado' : realtime.error,
    meta: {},
  });

  // --- Storage ---
  items.push(await checkStorage(url, baseHeaders, authed));

  return {
    key: 'backend',
    label: 'Banco de dados e backend',
    status: worstStatus(items.map((i) => i.status)),
    latencyMs: items.find((i) => i.key === 'system-health')?.latencyMs ?? null,
    items,
    meta: { authenticated: authed, projectRef: hostRef(url) },
  };
}

/**
 * HTTP 200 com lista vazia é o sintoma clássico de policy de RLS quebrada por
 * migration: todo usuário vê telas em branco e o monitor ingênuo fica verde.
 * Por isso as sondas marcadas com `expectRows` exigem pelo menos uma linha —
 * o usuário-monitor tem obrigatoriamente que enxergar a própria linha.
 */
async function checkDatabase(url, baseHeaders, authed, session) {
  const results = [];

  for (const probe of CONFIG.dbProbes) {
    if (probe.authOnly && !authed) {
      results.push({
        table: probe.table, label: probe.label, status: STATUS.SKIPPED, ms: null, rows: null,
        detail: session?.skipped ? 'sem usuário-monitor configurado' : 'sem sessão válida',
      });
      continue;
    }

    const r = await timedFetch(`${url}/rest/v1/${probe.table}?select=id&limit=1`, {
      headers: { ...baseHeaders, Prefer: 'count=exact', Range: '0-0' },
      maxBody: 2000,
    });

    // O total real vem no header Content-Range: "0-0/1234" ou "*/0".
    let rows = null;
    const range = r.headers?.['content-range'];
    if (range) {
      const total = String(range).split('/')[1];
      if (total && total !== '*') rows = Number(total);
    }
    if (rows == null && r.ok) {
      try { rows = Array.isArray(JSON.parse(r.body || '[]')) ? JSON.parse(r.body).length : null; } catch { /* ignore */ }
    }

    let status;
    let detail;
    if (r.status === 0) {
      status = STATUS.UNKNOWN;
      detail = r.error;
    } else if (r.status === 401 || r.status === 403) {
      status = STATUS.DEGRADED;
      detail = `acesso negado (HTTP ${r.status}) — permissões do usuário-monitor`;
    } else if (r.status === 404) {
      status = STATUS.FAIL;
      detail = 'tabela não encontrada — schema divergente do esperado';
    } else if (!r.ok) {
      status = STATUS.FAIL;
      detail = scrub(r.error) || `HTTP ${r.status}`;
    } else if (probe.expectRows && rows === 0) {
      status = STATUS.FAIL;
      detail = 'HTTP 200 mas ZERO linhas — a RLS não devolve nem a linha do próprio usuário-monitor';
    } else {
      status = statusFromLatency(r.ms, T.dbWarn, T.dbFail);
      detail = `${rows == null ? 'consulta OK' : `${rows} linha(s) visíveis`} em ${r.ms}ms`;
    }

    results.push({ table: probe.table, label: probe.label, status, ms: r.ms, rows, detail });
  }

  const latencies = results.filter((d) => d.ms != null).map((d) => d.ms);
  const bad = results.filter((d) => d.status === STATUS.FAIL || d.status === STATUS.DEGRADED);
  const skipped = results.filter((d) => d.status === STATUS.SKIPPED);
  const emptyRls = results.filter((d) => d.detail?.includes('ZERO linhas'));

  let detail;
  if (emptyRls.length) detail = `RLS suspeita de quebrada em: ${emptyRls.map((d) => d.table).join(', ')}`;
  else if (bad.length) detail = `${bad.length} com problema: ${bad.map((d) => d.table).join(', ')}`;
  else if (skipped.length === results.length) detail = 'nenhuma consulta executada — sem sessão';
  else detail = `${results.length - skipped.length} tabela(s) OK${skipped.length ? ` · ${skipped.length} pulada(s)` : ''}`;

  return {
    key: 'database',
    label: 'Consultas ao banco (com asserção de RLS)',
    status: worstStatus(results.map((d) => d.status)),
    latencyMs: latencies.length ? Math.round(median(latencies)) : null,
    detail,
    meta: { probes: results },
  };
}

async function checkStorage(url, baseHeaders, authed) {
  if (authed) {
    const r = await timedFetch(`${url}/storage/v1/bucket`, { headers: baseHeaders, readBody: false });
    return {
      key: 'storage',
      label: 'Armazenamento de arquivos',
      status: r.ok ? statusFromLatency(r.ms, T.dbWarn, T.dbFail) : r.status === 0 ? STATUS.UNKNOWN : STATUS.FAIL,
      latencyMs: r.ms,
      detail: r.ok ? 'serviço respondendo e acessível' : r.error || `HTTP ${r.status}`,
      meta: {},
    };
  }
  // Sem sessão só dá para provar que o serviço está roteando. Aceitamos apenas
  // os códigos que o Storage realmente devolve para um objeto inexistente —
  // um 4xx qualquer do gateway (projeto pausado, por exemplo) NÃO conta.
  const r = await timedFetch(`${url}/storage/v1/object/public/__monitor_probe__/x`, {
    headers: baseHeaders,
    maxBody: 500,
  });
  const expected = r.status === 400 || r.status === 404;
  return {
    key: 'storage',
    label: 'Armazenamento de arquivos',
    status: expected ? statusFromLatency(r.ms, T.dbWarn, T.dbFail) : STATUS.UNKNOWN,
    latencyMs: r.ms,
    detail: expected
      ? 'serviço respondendo (verificação superficial, sem sessão)'
      : `resposta inesperada (HTTP ${r.status || '—'}) — não verificável sem sessão`,
    meta: {},
  };
}

/**
 * Autentica o usuário-monitor.
 * Falha aqui é problema DO MONITOR, não do produto — quem consome este
 * resultado precisa tratar as duas coisas de forma diferente.
 */
export async function signIn() {
  const { email, password } = CONFIG.auth;
  if (!email || !password) {
    return { ok: false, skipped: true, reason: 'credenciais do usuário-monitor não configuradas', ms: null };
  }
  const { url, anonKey } = CONFIG.supabase;
  const r = await timedFetch(`${url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: anonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
    maxBody: 4000,
  });

  if (!r.ok) {
    let code = null;
    let reason = r.error || `HTTP ${r.status}`;
    try {
      const j = JSON.parse(r.body || '{}');
      code = j.error_code || j.error || null;
      reason = scrub(j.error_description || j.msg || j.message) || reason;
    } catch { /* ignore */ }
    // 400/401 = credencial errada/expirada → configuração do monitor.
    // 5xx/0    = o Auth do produto está com problema.
    const monitorFault = r.status === 400 || r.status === 401 || r.status === 422 || r.status === 429;
    return { ok: false, skipped: false, monitorFault, code, reason, ms: r.ms, httpStatus: r.status };
  }

  let json = {};
  try { json = JSON.parse(r.body || '{}'); } catch { /* ignore */ }
  return {
    ok: !!json.access_token,
    skipped: false,
    monitorFault: false,
    ms: r.ms,
    accessToken: json.access_token || null,
    expiresIn: json.expires_in || null,
    reason: json.access_token ? null : 'resposta sem token de acesso',
  };
}

function checkRealtime(url, anonKey) {
  return new Promise((resolve) => {
    const wsUrl = `${url.replace(/^http/, 'ws')}/realtime/v1/websocket?apikey=${anonKey}&vsn=1.0.0`;
    const t0 = performance.now();
    let settled = false;
    let ws;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws?.close(); } catch { /* ignore */ }
      resolve(v);
    };
    const timer = setTimeout(
      () => finish({ ok: false, ms: CONFIG.timeouts.realtime, error: 'tempo esgotado ao abrir o websocket' }),
      CONFIG.timeouts.realtime,
    );
    try {
      ws = new WebSocket(wsUrl);
      ws.on('open', () => finish({ ok: true, ms: Math.round(performance.now() - t0), error: null }));
      ws.on('error', (err) => finish({ ok: false, ms: Math.round(performance.now() - t0), error: describeError(err) }));
      ws.on('close', (code) => {
        if (!settled && code !== 1000) {
          finish({ ok: false, ms: Math.round(performance.now() - t0), error: `websocket fechou (código ${code})` });
        }
      });
    } catch (err) {
      finish({ ok: false, ms: Math.round(performance.now() - t0), error: describeError(err) });
    }
  });
}

function median(a) {
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function hostRef(url) {
  try { return new URL(url).hostname.split('.')[0]; } catch { return null; }
}
