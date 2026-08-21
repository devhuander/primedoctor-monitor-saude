/* PrimeDoctor — Monitor de Saúde
   Página estática. Lê os relatórios gerados pelo GitHub Actions e, opcionalmente,
   executa uma verificação ao vivo direto do navegador de quem está olhando. */

'use strict';

const STATUS_META = {
  ok:       { color: 'var(--ok)',       bg: 'var(--ok-bg)',       icon: '✓', label: 'Operacional' },
  degraded: { color: 'var(--degraded)', bg: 'var(--degraded-bg)', icon: '!', label: 'Degradado' },
  fail:     { color: 'var(--fail)',     bg: 'var(--fail-bg)',     icon: '✕', label: 'Falha' },
  skipped:  { color: 'var(--skipped)',  bg: 'var(--skipped-bg)',  icon: '–', label: 'Não verificado' },
  unknown:  { color: 'var(--unknown)',  bg: 'var(--unknown-bg)',  icon: '?', label: 'Indeterminado' },
};

const CARD_KEYS = ['frontend', 'backend', 'edge', 'experience'];
const CARD_HINTS = {
  frontend: 'DNS, TLS, HTML, bundles e arquivos estáticos do site publicado.',
  backend: 'Autenticação, PostgREST, Postgres, Realtime e armazenamento.',
  edge: 'Funções de borda que sustentam WhatsApp, agenda e captação de leads.',
  experience: 'Chromium real abrindo o app: componentes montados e tempo até a tela.',
  upstream: 'Status oficial das plataformas de que o sistema depende. Informativo.',
};

const state = { status: null, history: [], incidents: [] };

boot();

async function boot() {
  try {
    const [status, history, incidents] = await Promise.all([
      loadJson('./data/status.json'),
      loadJson('./data/history.json').catch(() => []),
      loadJson('./data/incidents.json').catch(() => []),
    ]);
    state.status = status;
    state.history = Array.isArray(history) ? history : [];
    state.incidents = Array.isArray(incidents) ? incidents : [];
    render();
  } catch (err) {
    document.getElementById('content').innerHTML = `
      <div class="banner" style="--st-color:var(--unknown);--st-bg:var(--unknown-bg)">
        <div class="pulse">?</div>
        <div>
          <h2>Sem dados de verificação</h2>
          <p>Nenhum relatório foi encontrado em <code>data/status.json</code>. Isso é esperado antes da
          primeira execução do monitor. Rode o workflow <b>Monitor de saúde</b> nas Actions do repositório
          para gerar o primeiro relatório.<br><small>${escapeHtml(err.message)}</small></p>
        </div>
      </div>`;
    document.getElementById('meta').textContent = 'aguardando primeira execução';
  }
}

async function loadJson(url) {
  const res = await fetch(`${url}?v=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`não foi possível carregar ${url} (HTTP ${res.status})`);
  return res.json();
}

/* ------------------------------------------------------------------ render */

function render() {
  const s = state.status;
  const target = s.target?.url || 'primedoctor.app';
  document.getElementById('target-url').textContent = target.replace(/^https?:\/\//, '');

  const age = Date.now() - new Date(s.generatedAt).getTime();
  const stale = age > 3 * 3600 * 1000; // > 3h sem rodar = suspeito (cron é horário)

  document.getElementById('meta').innerHTML = `
    Última verificação <b>${relTime(s.generatedAt)}</b><br>
    <span title="${escapeHtml(new Date(s.generatedAt).toLocaleString('pt-BR'))}">
      ${escapeHtml(new Date(s.generatedAt).toLocaleString('pt-BR'))}
    </span> · ${(s.durationMs / 1000).toFixed(1)}s
    ${s.runner?.runUrl ? ` · <a href="${escapeHtml(s.runner.runUrl)}" target="_blank" rel="noopener">execução</a>` : ''}
  `;

  const graded = (s.sections || []).filter((x) => !x.informational);
  const upstream = (s.sections || []).find((x) => x.key === 'upstream');

  document.getElementById('content').innerHTML = [
    stale ? staleWarning(s.generatedAt) : '',
    banner(s),
    `<div class="cards">${CARD_KEYS.map((k) => card(s, k)).join('')}</div>`,
    charts(),
    graded.map((sec) => section(sec)).join(''),
    upstream ? section(upstream) : '',
    incidentsBlock(),
    liveBlock(),
    notesBlock(s),
    footer(s),
  ].join('');

  drawCharts();
  wireLive();
}

function staleWarning(ts) {
  return `<div class="banner" style="--st-color:var(--degraded);--st-bg:var(--degraded-bg)">
    <div class="pulse">!</div>
    <div>
      <h2>Estes dados estão velhos</h2>
      <p>A última verificação foi ${relTime(ts)}, mas o monitor deveria rodar de hora em hora.
      O próprio robô de monitoramento pode estar parado — verifique as GitHub Actions do repositório.
      <b>Não trate os status abaixo como situação atual.</b></p>
    </div>
  </div>`;
}

function banner(s) {
  const st = STATUS_META[s.overall.status] || STATUS_META.unknown;
  const window24 = state.history.slice(-24);
  const okCount = window24.filter((h) => h.s === 'ok').length;
  return `<div class="banner" style="--st-color:${st.color};--st-bg:${st.bg}">
    <div class="pulse">${st.icon}</div>
    <div style="flex:1">
      <h2>${escapeHtml(s.overall.label)}</h2>
      <p>${escapeHtml(s.overall.summary)}
      ${window24.length ? `<br>Nas últimas ${window24.length} verificações: <b>${okCount}</b> totalmente OK.` : ''}
      ${s.authenticated ? '' : '<br><b>Atenção:</b> as checagens da área autenticada não rodaram nesta execução.'}
      </p>
    </div>
  </div>`;
}

function card(s, key) {
  const sec = (s.sections || []).find((x) => x.key === key);
  if (!sec) return '';
  const st = STATUS_META[sec.status] || STATUS_META.unknown;
  const hist = state.history.slice(-60);
  const letter = { frontend: 'f', backend: 'b', edge: 'e', experience: 'x' }[key];
  const bars = hist.map((h) => `<i data-s="${escapeHtml(h[letter] || 'unknown')}" title="${escapeHtml(new Date(h.t).toLocaleString('pt-BR'))} — ${escapeHtml(STATUS_META[h[letter]]?.label || '?')}"></i>`).join('');
  const up = uptimePct(hist, letter);

  return `<div class="card" style="--st-color:${st.color};--st-bg:${st.bg}">
    <div class="card-head">
      <span class="dot"></span>
      <h3>${escapeHtml(sec.label)}</h3>
      <span class="badge">${st.label}</span>
    </div>
    <div class="sub">${escapeHtml(sec.detail || '')}</div>
    <div class="num">${up == null ? '—' : up.toFixed(1) + '%'}<small>disponível</small></div>
    <div class="bars">${bars || '<i></i>'}</div>
    <div class="bars-legend"><span>${hist.length ? relTime(hist[0].t) : ''}</span><span>agora</span></div>
  </div>`;
}

function uptimePct(hist, letter) {
  const vals = hist.map((h) => h[letter]).filter((v) => v && v !== 'skipped' && v !== 'unknown');
  if (!vals.length) return null;
  const ok = vals.filter((v) => v === 'ok').length;
  return (ok / vals.length) * 100;
}

const CHART_DEFS = [
  { k: 'doc', title: 'Resposta do site', unit: 'ms', hint: 'tempo do HTML principal' },
  { k: 'db', title: 'Banco de dados', unit: 'ms', hint: 'healthcheck com consulta real' },
  { k: 'edge', title: 'Funções de borda', unit: 'ms', hint: 'média das integrações' },
  { k: 'load', title: 'App pronto na tela', unit: 's', hint: 'Chromium até montar o app' },
];

function charts() {
  return `<div class="charts">${CHART_DEFS.map((c) => {
    const vals = state.history.map((h) => h.lat?.[c.k]).filter((v) => typeof v === 'number');
    const last = vals.length ? vals[vals.length - 1] : null;
    const shown = c.unit === 's' ? (last != null ? (last / 1000).toFixed(2) : '—') : (last != null ? Math.round(last) : '—');
    return `<div class="chart">
      <h4>${escapeHtml(c.title)}</h4>
      <div class="now">${shown}<small>${last == null ? '' : ' ' + c.unit}</small></div>
      <svg data-chart="${c.k}" viewBox="0 0 300 46" preserveAspectRatio="none" aria-hidden="true"></svg>
      <div class="foot">${escapeHtml(c.hint)}${vals.length ? ` · mediana ${fmt(median(vals), c.unit)}` : ''}</div>
    </div>`;
  }).join('')}</div>`;
}

function drawCharts() {
  for (const c of CHART_DEFS) {
    const svg = document.querySelector(`svg[data-chart="${c.k}"]`);
    if (!svg) continue;
    const vals = state.history.map((h) => h.lat?.[c.k]).filter((v) => typeof v === 'number').slice(-120);
    if (vals.length < 2) {
      svg.innerHTML = `<text x="150" y="28" text-anchor="middle" fill="var(--text-faint)" font-size="10">sem histórico suficiente</text>`;
      continue;
    }
    const max = Math.max(...vals) * 1.12 || 1;
    const min = Math.min(...vals) * 0.9;
    const span = Math.max(max - min, 1);
    const pts = vals.map((v, i) => {
      const x = (i / (vals.length - 1)) * 300;
      const y = 44 - ((v - min) / span) * 40;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    svg.innerHTML = `
      <polyline points="${pts.join(' ')}" fill="none" stroke="var(--accent)" stroke-width="1.8"
        stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke" />
      <polygon points="0,46 ${pts.join(' ')} 300,46" fill="var(--accent)" opacity=".10" />`;
  }
}

function section(sec) {
  const st = STATUS_META[sec.status] || STATUS_META.unknown;
  const open = sec.status === 'fail' || sec.status === 'degraded';
  const items = (sec.items || []).map(itemRow).join('');
  return `<details class="section" ${open ? 'open' : ''} style="--st-color:${st.color};--st-bg:${st.bg}">
    <summary>
      <span class="chev">▶</span>
      <span class="dot"></span>
      <h3>${escapeHtml(sec.label)}</h3>
      <span class="hint">${escapeHtml(sec.detail || '')}</span>
      <span class="badge">${sec.informational ? 'Informativo' : st.label}</span>
    </summary>
    <div class="items">
      ${items || `<div class="item"><span></span><div><div class="desc">${escapeHtml(CARD_HINTS[sec.key] || 'Sem detalhes.')}</div></div><span></span></div>`}
    </div>
  </details>`;
}

function itemRow(it) {
  const st = STATUS_META[it.status] || STATUS_META.unknown;
  const samples = it.meta?.samples?.length
    ? `<div class="samples">${it.meta.samples.map(escapeHtml).join('\n')}</div>`
    : it.meta?.failed?.length
      ? `<div class="samples">${it.meta.failed.map((f) => escapeHtml(`${f.reason} — ${f.url}`)).join('\n')}</div>`
      : it.meta?.probes?.length
        ? `<div class="samples">${it.meta.probes.map((p) => escapeHtml(`${pad(p.table, 18)} ${p.status.padEnd(9)} ${p.ms != null ? p.ms + 'ms' : '—'}`)).join('\n')}</div>`
        : '';
  return `<div class="item" style="--st-color:${st.color};--st-bg:${st.bg}">
    <span class="dot idot"></span>
    <div>
      <div class="name">${escapeHtml(it.label)}${it.critical === false ? ' <span style="color:var(--text-faint);font-weight:400;font-size:11px">(não crítica)</span>' : ''}</div>
      <div class="desc">${escapeHtml(it.detail || st.label)}</div>
      ${samples}
    </div>
    <span class="lat">${it.latencyMs != null ? fmt(it.latencyMs, 'ms') : ''}</span>
  </div>`;
}

function incidentsBlock() {
  const list = state.incidents || [];
  if (!list.length) {
    return `<details class="section" style="--st-color:var(--ok);--st-bg:var(--ok-bg)">
      <summary><span class="chev">▶</span><span class="dot"></span><h3>Histórico de incidentes</h3>
      <span class="hint">nenhum incidente registrado desde o início do monitoramento</span>
      <span class="badge">Limpo</span></summary>
      <div class="items"><div class="item"><span></span><div><div class="desc">Nada a relatar. Incidentes aparecem aqui automaticamente quando duas ou mais verificações consecutivas saem do verde.</div></div><span></span></div></div>
    </details>`;
  }
  const openNow = list.filter((i) => !i.endedAt).length;
  const st = openNow ? STATUS_META.fail : STATUS_META.degraded;
  return `<details class="section" ${openNow ? 'open' : ''} style="--st-color:${st.color};--st-bg:${st.bg}">
    <summary><span class="chev">▶</span><span class="dot"></span><h3>Histórico de incidentes</h3>
    <span class="hint">${list.length} registrado(s)${openNow ? ` · ${openNow} em aberto` : ''}</span>
    <span class="badge">${openNow ? 'Em aberto' : 'Resolvidos'}</span></summary>
    <div class="items">${list.slice(0, 20).map((i) => {
      const m = STATUS_META[i.worst] || STATUS_META.unknown;
      return `<div class="item" style="--st-color:${m.color};--st-bg:${m.bg}">
        <span class="dot idot"></span>
        <div>
          <div class="name">${escapeHtml(new Date(i.startedAt).toLocaleString('pt-BR'))}${i.endedAt ? '' : ' — em andamento'}</div>
          <div class="desc">Afetou: ${escapeHtml(i.areas.join(', ') || 'não classificado')} · ${i.checks} verificação(ões)${
            i.durationMinutes != null ? ` · durou ~${formatDuration(i.durationMinutes)}` : ''
          }</div>
        </div>
        <span class="lat">${m.label}</span>
      </div>`;
    }).join('')}</div>
  </details>`;
}

/* -------------------------------------------------- verificação ao vivo */

function liveBlock() {
  return `<details class="section" style="--st-color:var(--accent);--st-bg:var(--accent-soft)">
    <summary><span class="chev">▶</span><span class="dot"></span><h3>Verificar agora, do seu navegador</h3>
    <span class="hint">pulso em tempo real, sem esperar o próximo ciclo</span>
    <span class="badge">Ao vivo</span></summary>
    <div class="items">
      <div class="item" style="grid-template-columns:1fr">
        <div>
          <div class="live-head">
            <button class="btn" id="live-btn">Executar verificação ao vivo</button>
            <span class="desc" id="live-status">Testa os endpoints públicos a partir do seu computador e da sua rede.</span>
          </div>
          <div id="live-results"></div>
        </div>
      </div>
    </div>
  </details>`;
}

function wireLive() {
  const btn = document.getElementById('live-btn');
  if (!btn) return;
  btn.addEventListener('click', runLive);
}

async function runLive() {
  const btn = document.getElementById('live-btn');
  const statusEl = document.getElementById('live-status');
  const out = document.getElementById('live-results');
  btn.disabled = true;
  statusEl.textContent = 'verificando…';
  out.innerHTML = '';

  const supa = state.status?.target?.supabaseRef
    ? `https://${state.status.target.supabaseRef}.supabase.co`
    : null;
  const app = state.status?.target?.url || 'https://primedoctor.app';

  const tests = [
    {
      label: 'Site alcançável',
      note: 'requisição sem CORS: prova DNS + TCP + TLS, mas não o código HTTP',
      run: () => opaque(app + '/favicon.ico'),
    },
    supa && {
      label: 'Autenticação (Supabase)',
      note: 'GET /auth/v1/health',
      run: () => probe(`${supa}/auth/v1/health`),
    },
    supa && {
      label: 'Healthcheck do backend',
      note: 'GET /functions/v1/system-health — consulta real no banco',
      run: () => probe(`${supa}/functions/v1/system-health`),
    },
  ].filter(Boolean);

  const rows = [];
  for (const t of tests) {
    let r;
    try { r = await t.run(); } catch (e) { r = { ok: false, ms: null, detail: String(e.message || e) }; }
    const st = r.ok ? STATUS_META.ok : STATUS_META.fail;
    rows.push(`<div class="item" style="--st-color:${st.color};--st-bg:${st.bg};padding-left:0;padding-right:0">
      <span class="dot idot"></span>
      <div><div class="name">${escapeHtml(t.label)}</div>
      <div class="desc">${escapeHtml(r.detail)} — <span style="color:var(--text-faint)">${escapeHtml(t.note)}</span></div></div>
      <span class="lat">${r.ms != null ? r.ms + 'ms' : ''}</span>
    </div>`);
    out.innerHTML = rows.join('');
  }

  statusEl.textContent = `verificado às ${new Date().toLocaleTimeString('pt-BR')}`;
  btn.disabled = false;
}

async function probe(url) {
  const t0 = performance.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
    const ms = Math.round(performance.now() - t0);
    let extra = '';
    try {
      const j = await res.json();
      if (j.db) extra = ` · banco: ${j.db}${j.latency_ms != null ? ` (${j.latency_ms}ms)` : ''}`;
      else if (j.version) extra = ` · ${j.version}`;
    } catch { /* corpo não-JSON */ }
    return { ok: res.ok, ms, detail: `HTTP ${res.status}${extra}` };
  } catch (e) {
    return { ok: false, ms: Math.round(performance.now() - t0), detail: e.name === 'AbortError' ? 'tempo esgotado' : 'não respondeu' };
  } finally {
    clearTimeout(timer);
  }
}

async function opaque(url) {
  const t0 = performance.now();
  try {
    await fetch(url, { mode: 'no-cors', cache: 'no-store' });
    return { ok: true, ms: Math.round(performance.now() - t0), detail: 'respondeu' };
  } catch {
    return { ok: false, ms: Math.round(performance.now() - t0), detail: 'não respondeu' };
  }
}

/* --------------------------------------------------------------- rodapé */

function notesBlock(s) {
  return `<div class="note">
    <b>Como ler esta página.</b>
    O monitor roda de hora em hora num servidor do GitHub, fora da infraestrutura do PrimeDoctor —
    se a hospedagem do sistema cair, esta página continua no ar.
    Cada verificação abre o app num navegador Chromium real, autentica com um usuário dedicado,
    consulta o banco e confere se as funções de borda continuam publicadas.
    <br><br>
    <b>Limites honestos.</b>
    Verde aqui significa que o caminho verificado respondeu — não que todos os fluxos do produto estejam
    corretos. A frequência é horária, então uma queda curta entre dois ciclos pode não aparecer.
    A verificação ao vivo usa a sua rede e mede apenas endpoints com CORS aberto.
    <br><br>
    <b>Privacidade.</b> Nenhum dado de paciente, clínica ou usuário é lido, gravado ou exibido:
    o monitor registra apenas latência, código de resposta e sucesso/erro.
    Mensagens de erro passam por um filtro que remove e-mails, identificadores e tokens.
  </div>`;
}

function footer(s) {
  return `<footer>
    Alvo: <a href="${escapeHtml(s.target.url)}" target="_blank" rel="noopener">${escapeHtml(s.target.url)}</a>
    · Página gerada em ${escapeHtml(new Date(s.generatedAt).toLocaleString('pt-BR'))}
    · <a href="https://github.com/devhuander/primedoctor-monitor-saude" target="_blank" rel="noopener">código-fonte</a>
    <br>Esta página atualiza sozinha a cada 5 minutos.
  </footer>`;
}

setInterval(() => { boot(); }, 5 * 60 * 1000);

/* -------------------------------------------------------------- helpers */

function fmt(v, unit) {
  if (v == null) return '—';
  if (unit === 's') return v < 1000 ? `${Math.round(v)}ms` : `${(v / 1000).toFixed(2)}s`;
  return v < 1000 ? `${Math.round(v)}ms` : `${(v / 1000).toFixed(2)}s`;
}

function median(a) {
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function relTime(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.round(diff / 60000);
  if (min < 1) return 'agora mesmo';
  if (min < 60) return `há ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `há ${h}h`;
  return `há ${Math.round(h / 24)} dia(s)`;
}

function formatDuration(minutes) {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h}h${String(m).padStart(2, '0')}` : `${h}h`;
}

function pad(s, n) {
  return String(s).length >= n ? String(s).slice(0, n) : String(s) + ' '.repeat(n - String(s).length);
}

function escapeHtml(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
