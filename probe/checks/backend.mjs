import WebSocket from 'ws';
import { CONFIG, STATUS, worstStatus, statusFromLatency } from '../config.mjs';
import { timedFetch, describeError } from '../lib/http.mjs';

const T = CONFIG.thresholds;

/**
 * Saúde do backend: Auth, PostgREST, Postgres (via consultas reais),
 * Realtime, Storage e o healthcheck próprio do PrimeDoctor.
 *
 * Nunca gravamos conteúdo de linhas — apenas latência, sucesso e código de erro.
 */
export async function checkBackend(session) {
  const { url, anonKey } = CONFIG.supabase;
  const items = [];
  const authed = !!session?.accessToken;
  const bearer = authed ? session.accessToken : anonKey;
  const baseHeaders = { apikey: anonKey, Authorization: `Bearer ${bearer}` };

  // --- GoTrue (autenticação) ---
  const auth = await timedFetch(`${url}/auth/v1/health`, { headers: { apikey: anonKey } });
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

  // --- PostgREST (camada de API do banco) ---
  const rest = await timedFetch(`${url}/rest/v1/`, { headers: baseHeaders, maxBody: 0 });
  items.push({
    key: 'postgrest',
    label: 'API do banco (PostgREST)',
    status: rest.ok ? statusFromLatency(rest.ms, T.dbWarn, T.dbFail) : STATUS.FAIL,
    latencyMs: rest.ms,
    detail: rest.ok ? 'no ar' : rest.error || `HTTP ${rest.status}`,
    meta: {},
  });

  // --- Healthcheck oficial do PrimeDoctor (bate no Postgres com service role) ---
  const health = await timedFetch(`${url}/functions/v1/system-health`, {
    headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}` },
  });
  let healthJson = {};
  try { healthJson = JSON.parse(health.body || '{}'); } catch { /* ignore */ }
  const dbOk = healthJson.db === 'ok';
  items.push({
    key: 'system-health',
    label: 'Healthcheck do PrimeDoctor (banco)',
    status: health.ok && dbOk ? statusFromLatency(health.ms, T.dbWarn, T.dbFail) : STATUS.FAIL,
    latencyMs: health.ms,
    detail: health.ok
      ? dbOk
        ? `banco respondendo em ${healthJson.latency_ms ?? '?'}ms`
        : `banco com falha: ${sanitize(healthJson.db_error) || 'sem detalhe'}`
      : health.error || `HTTP ${health.status}`,
    meta: { dbLatencyMs: healthJson.latency_ms ?? null },
  });

  // --- Consultas reais em tabelas (prova o caminho completo: rede → PostgREST → Postgres → RLS) ---
  const dbResults = [];
  for (const probe of CONFIG.dbProbes) {
    if (probe.authOnly && !authed) {
      dbResults.push({ table: probe.table, label: probe.label, status: STATUS.SKIPPED, ms: null, detail: 'requer sessão' });
      continue;
    }
    const r = await timedFetch(`${url}/rest/v1/${probe.table}?select=id&limit=1`, {
      headers: { ...baseHeaders, Prefer: 'count=none' },
      maxBody: 400,
    });
    // 200 = leu; 206 = parcial. 401/403 com sessão válida indica RLS bloqueando (degradado, não queda).
    let status;
    let detail;
    if (r.ok) {
      status = statusFromLatency(r.ms, T.dbWarn, T.dbFail);
      detail = `consulta OK em ${r.ms}ms`;
    } else if (r.status === 401 || r.status === 403) {
      status = STATUS.DEGRADED;
      detail = `acesso negado pela RLS (HTTP ${r.status}) — verifique as permissões do usuário-monitor`;
    } else if (r.status === 404) {
      status = STATUS.FAIL;
      detail = 'tabela não encontrada (schema divergente do esperado)';
    } else {
      status = STATUS.FAIL;
      detail = r.error || `HTTP ${r.status}`;
    }
    dbResults.push({ table: probe.table, label: probe.label, status, ms: r.ms, detail });
  }
  const dbLatencies = dbResults.filter((d) => d.ms != null).map((d) => d.ms);
  items.push({
    key: 'database',
    label: 'Consultas ao banco de dados',
    status: worstStatus(dbResults.map((d) => d.status)),
    latencyMs: dbLatencies.length ? Math.round(median(dbLatencies)) : null,
    detail: summarize(dbResults),
    meta: { probes: dbResults },
  });

  // --- Realtime (websocket) ---
  const realtime = await checkRealtime(url, anonKey);
  items.push({
    key: 'realtime',
    label: 'Realtime (tempo real)',
    status: realtime.ok ? statusFromLatency(realtime.ms, 2000, 8000) : STATUS.FAIL,
    latencyMs: realtime.ms,
    detail: realtime.ok ? 'websocket conectado' : realtime.error,
    meta: {},
  });

  // --- Storage ---
  const storagePath = authed ? `${url}/storage/v1/bucket` : `${url}/storage/v1/object/public/__monitor_probe__`;
  const storage = await timedFetch(storagePath, { headers: baseHeaders, maxBody: 0 });
  // Sem sessão, esperamos 400/404 do objeto inexistente — o que já prova que o serviço responde.
  const storageAlive = authed ? storage.ok : storage.status > 0 && storage.status < 500;
  items.push({
    key: 'storage',
    label: 'Armazenamento de arquivos',
    status: storageAlive ? statusFromLatency(storage.ms, T.dbWarn, T.dbFail) : STATUS.FAIL,
    latencyMs: storage.ms,
    detail: storageAlive
      ? authed ? 'serviço respondendo e acessível' : 'serviço respondendo'
      : storage.error || `HTTP ${storage.status}`,
    meta: {},
  });

  return {
    key: 'backend',
    label: 'Banco de dados e backend',
    status: worstStatus(items.map((i) => i.status)),
    latencyMs: items.find((i) => i.key === 'system-health')?.latencyMs ?? null,
    items,
    meta: { authenticated: authed, projectRef: hostRef(url) },
  };
}

/** Autentica o usuário-monitor. Devolve sessão ou motivo da falha. */
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
    let reason = r.error || `HTTP ${r.status}`;
    try {
      const j = JSON.parse(r.body || '{}');
      reason = sanitize(j.error_description || j.msg || j.message) || reason;
    } catch { /* ignore */ }
    return { ok: false, skipped: false, reason, ms: r.ms };
  }
  let json = {};
  try { json = JSON.parse(r.body || '{}'); } catch { /* ignore */ }
  return {
    ok: !!json.access_token,
    skipped: false,
    ms: r.ms,
    accessToken: json.access_token || null,
    refreshToken: json.refresh_token || null,
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
      () => finish({ ok: false, ms: CONFIG.timeouts.realtime, error: 'timeout ao abrir o websocket' }),
      CONFIG.timeouts.realtime,
    );
    try {
      ws = new WebSocket(wsUrl);
      ws.on('open', () => finish({ ok: true, ms: Math.round(performance.now() - t0), error: null }));
      ws.on('error', (err) =>
        finish({ ok: false, ms: Math.round(performance.now() - t0), error: describeError(err) }),
      );
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

function summarize(results) {
  const ok = results.filter((r) => r.status === STATUS.OK).length;
  const skipped = results.filter((r) => r.status === STATUS.SKIPPED).length;
  const bad = results.filter((r) => r.status === STATUS.FAIL || r.status === STATUS.DEGRADED);
  if (bad.length) return `${bad.length} com problema: ${bad.map((b) => b.table).join(', ')}`;
  return `${ok} tabela(s) OK${skipped ? ` · ${skipped} pulada(s)` : ''}`;
}

function median(a) {
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function hostRef(url) {
  try { return new URL(url).hostname.split('.')[0]; } catch { return null; }
}

/** Remove qualquer coisa que pareça e-mail, UUID ou token de mensagens de erro. */
export function sanitize(text) {
  if (!text) return text;
  return String(text)
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '«email»')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '«id»')
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '«token»')
    .slice(0, 400);
}
