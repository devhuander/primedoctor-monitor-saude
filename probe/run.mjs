#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG, STATUS, worstStatus } from './config.mjs';
import { checkFrontend } from './checks/frontend.mjs';
import { checkBackend, signIn, sanitize } from './checks/backend.mjs';
import { checkEdgeFunctions } from './checks/edge.mjs';
import { checkBrowser } from './checks/browser.mjs';
import { checkUpstreams } from './checks/upstream.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(ROOT, 'data');
const SKIP_BROWSER = process.argv.includes('--no-browser') || process.env.PD_SKIP_BROWSER === '1';

async function main() {
  const startedAt = new Date();
  const t0 = Date.now();
  log('Iniciando verificação de saúde do PrimeDoctor…');

  // Login primeiro: a sessão é reaproveitada nas checagens de banco.
  const session = await signIn();
  if (session.skipped) log('· usuário-monitor não configurado, checagens autenticadas serão puladas');
  else if (session.ok) log(`· sessão obtida em ${session.ms}ms`);
  else log(`· login falhou: ${sanitize(session.reason)}`);

  const [frontend, backend, edge, upstream] = await Promise.all([
    safe('frontend', 'Hospedagem e front-end', checkFrontend),
    safe('backend', 'Banco de dados e backend', () => checkBackend(session)),
    safe('edge', 'Funções de borda (integrações)', checkEdgeFunctions),
    safe('upstream', 'Plataformas de terceiros', checkUpstreams),
  ]);

  const experience = SKIP_BROWSER
    ? {
        key: 'experience',
        label: 'Experiência de carregamento',
        status: STATUS.SKIPPED,
        latencyMs: null,
        items: [],
        detail: 'checagem de navegador desativada nesta execução',
        meta: {},
      }
    : await safe('experience', 'Experiência de carregamento', () => checkBrowser(session));

  const sections = [frontend, backend, edge, experience, upstream];
  const graded = sections.filter((s) => !s.informational);
  const overall = worstStatus(graded.map((s) => s.status));

  const report = {
    schemaVersion: 2,
    generatedAt: startedAt.toISOString(),
    durationMs: Date.now() - t0,
    target: { name: CONFIG.app.name, url: CONFIG.app.baseUrl, supabaseRef: refOf(CONFIG.supabase.url) },
    authenticated: !!session.ok,
    overall: {
      status: overall,
      label: overallLabel(overall),
      summary: buildSummary(graded, overall),
    },
    sections: sections.map(withDetail),
    runner: {
      source: process.env.GITHUB_ACTIONS ? 'github-actions' : 'local',
      runUrl:
        process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
          ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
          : null,
    },
  };

  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(path.join(DATA_DIR, 'status.json'), JSON.stringify(report, null, 2) + '\n');

  const history = await appendHistory(report);
  const incidents = buildIncidents(history);
  await fs.writeFile(path.join(DATA_DIR, 'incidents.json'), JSON.stringify(incidents, null, 2) + '\n');

  log(`Concluído em ${((Date.now() - t0) / 1000).toFixed(1)}s — status geral: ${overall.toUpperCase()}`);
  for (const s of sections) log(`  ${icon(s.status)} ${s.label}: ${s.detail || s.status}`);

  // Nunca falha o job por causa do resultado do sistema monitorado — a página
  // precisa ser publicada justamente quando algo está vermelho.
  process.exit(0);
}

/** Executa uma checagem sem deixar exceção derrubar o relatório inteiro. */
async function safe(key, label, fn) {
  try {
    return await fn();
  } catch (err) {
    return {
      key,
      label,
      status: STATUS.UNKNOWN,
      latencyMs: null,
      items: [],
      detail: `checagem não pôde ser executada: ${sanitize(err?.message || String(err))}`,
      meta: { error: true },
    };
  }
}

function withDetail(section) {
  if (section.detail) return section;
  const items = section.items || [];
  const bad = items.filter((i) => i.status === STATUS.FAIL || i.status === STATUS.DEGRADED);
  return {
    ...section,
    detail: bad.length ? bad.map((b) => b.label).join(' · ') : `${items.length} verificação(ões) OK`,
  };
}

function buildSummary(sections, overall) {
  if (overall === STATUS.OK) return 'Todos os sistemas operando normalmente.';
  const bad = sections.filter((s) => s.status === STATUS.FAIL);
  const warn = sections.filter((s) => s.status === STATUS.DEGRADED);
  const parts = [];
  if (bad.length) parts.push(`Falha em: ${bad.map((s) => s.label.toLowerCase()).join(', ')}`);
  if (warn.length) parts.push(`Degradação em: ${warn.map((s) => s.label.toLowerCase()).join(', ')}`);
  if (!parts.length) parts.push('Não foi possível concluir todas as verificações.');
  return parts.join('. ') + '.';
}

function overallLabel(s) {
  return (
    {
      ok: 'Todos os sistemas operacionais',
      degraded: 'Desempenho degradado',
      fail: 'Falha detectada',
      unknown: 'Estado indeterminado',
      skipped: 'Verificação parcial',
    }[s] || 'Estado indeterminado'
  );
}

/** Série temporal compacta — só o necessário para desenhar barras e gráficos. */
async function appendHistory(report) {
  const file = path.join(DATA_DIR, 'history.json');
  let history = [];
  try {
    history = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!Array.isArray(history)) history = [];
  } catch { /* primeira execução */ }

  const sec = (k) => report.sections.find((s) => s.key === k);
  const item = (k, ik) => (sec(k)?.items || []).find((i) => i.key === ik);

  history.push({
    t: report.generatedAt,
    s: report.overall.status,
    f: sec('frontend')?.status ?? STATUS.UNKNOWN,
    b: sec('backend')?.status ?? STATUS.UNKNOWN,
    e: sec('edge')?.status ?? STATUS.UNKNOWN,
    x: sec('experience')?.status ?? STATUS.UNKNOWN,
    lat: {
      doc: item('frontend', 'document')?.latencyMs ?? null,
      db: item('backend', 'system-health')?.latencyMs ?? null,
      edge: sec('edge')?.latencyMs ?? null,
      load: item('experience', 'public.load')?.latencyMs ?? null,
      lcp: item('experience', 'public.lcp')?.latencyMs ?? null,
      login: item('experience', 'authed.components')?.latencyMs ?? null,
    },
  });

  if (history.length > CONFIG.history.maxEntries) {
    history = history.slice(history.length - CONFIG.history.maxEntries);
  }
  await fs.writeFile(file, JSON.stringify(history) + '\n');
  return history;
}

/** Agrupa execuções não-OK consecutivas em incidentes legíveis. */
function buildIncidents(history) {
  const incidents = [];
  let open = null;
  for (const h of history) {
    const bad = h.s === STATUS.FAIL || h.s === STATUS.DEGRADED;
    if (bad && !open) {
      open = { startedAt: h.t, endedAt: null, worst: h.s, checks: 1, areas: areasOf(h) };
    } else if (bad && open) {
      open.checks += 1;
      if (h.s === STATUS.FAIL) open.worst = STATUS.FAIL;
      for (const a of areasOf(h)) if (!open.areas.includes(a)) open.areas.push(a);
    } else if (!bad && open) {
      open.endedAt = h.t;
      incidents.push(open);
      open = null;
    }
  }
  if (open) incidents.push(open);
  return incidents
    .reverse()
    .slice(0, 50)
    .map((i) => ({
      ...i,
      durationMinutes:
        i.endedAt != null ? Math.round((new Date(i.endedAt) - new Date(i.startedAt)) / 60000) : null,
    }));
}

function areasOf(h) {
  const names = { f: 'front-end', b: 'backend', e: 'integrações', x: 'carregamento' };
  return Object.entries(names)
    .filter(([k]) => h[k] === STATUS.FAIL || h[k] === STATUS.DEGRADED)
    .map(([, v]) => v);
}

function refOf(url) {
  try { return new URL(url).hostname.split('.')[0]; } catch { return null; }
}

function icon(s) {
  return { ok: '✔', degraded: '▲', fail: '✖', skipped: '–', unknown: '?' }[s] || '?';
}

function log(msg) {
  process.stdout.write(`${msg}\n`);
}

main().catch((err) => {
  console.error('Falha fatal no monitor:', err);
  process.exit(1);
});
