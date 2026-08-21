#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG, STATUS, worstStatus, isBad } from './config.mjs';
import { selfTest } from './checks/selftest.mjs';
import { checkFrontend } from './checks/frontend.mjs';
import { checkBackend, signIn } from './checks/backend.mjs';
import { checkEdgeFunctions } from './checks/edge.mjs';
import { checkBrowser } from './checks/browser.mjs';
import { checkUpstreams } from './checks/upstream.mjs';
import { scrub } from './lib/sanitize.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(ROOT, 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'history.jsonl');
const SKIP_BROWSER = process.argv.includes('--no-browser') || process.env.PD_SKIP_BROWSER === '1';

async function main() {
  const startedAt = new Date();
  const t0 = Date.now();
  log('Iniciando verificação de saúde do PrimeDoctor…');

  // ---- 0. O monitor tem rede? ----
  const self = await selfTest();
  log(`· autoteste: ${self.detail}`);
  if (!self.networkOk) {
    await writeReport(buildOfflineReport(startedAt, t0, self));
    log('Abortado: o monitor está sem rede. Nada foi julgado e nenhum alarme será disparado.');
    process.exit(0);
  }

  // ---- 1. Sessão (reaproveitada nas sondas de banco) ----
  const session = await signIn();
  if (session.skipped) log('· usuário-monitor não configurado; checagens autenticadas serão puladas');
  else if (session.ok) log(`· sessão obtida em ${session.ms}ms`);
  else log(`· login falhou (${session.monitorFault ? 'culpa do monitor' : 'culpa do produto'}): ${scrub(session.reason)}`);

  // ---- 2. Checagens ----
  const [frontend, backend, edge, upstream] = await Promise.all([
    safe('frontend', 'Hospedagem e front-end', checkFrontend),
    safe('backend', 'Banco de dados e backend', () => checkBackend(session)),
    safe('edge', 'Funções de borda (integrações)', checkEdgeFunctions),
    safe('upstream', 'Plataformas de terceiros', checkUpstreams),
  ]);

  const experience = SKIP_BROWSER
    ? skippedSection('experience', 'Experiência de carregamento', 'checagem de navegador desativada nesta execução')
    : await safe('experience', 'Experiência de carregamento', () => checkBrowser(session));

  let sections = [frontend, backend, edge, experience, upstream];
  const rootCause = suppressCascade(sections);
  sections = rootCause.sections;

  // ---- 3. Veredito ----
  const graded = sections.filter((s) => !s.informational);
  const instant = worstStatus(graded.map((s) => s.status));
  const monitorFault = session.monitorFault === true;

  // "Ruim" é qualquer seção graduada em falha/degradação — não o status geral.
  // O geral pode ser "skipped" (por exemplo, sem navegador) sem que nada esteja
  // quebrado, e isso não pode nem abrir nem manter aberto um incidente.
  const anyBad = graded.some((s) => isBad(s.status));
  const history = await readHistory();
  const recent = history.slice(-(CONFIG.alarm.consecutiveBadRuns - 1));
  const previousBad =
    recent.length === CONFIG.alarm.consecutiveBadRuns - 1 && recent.every((h) => entryIsBad(h));
  // Alarme só depois de N ciclos ruins consecutivos: n=1 num runner
  // compartilhado produz alarme falso e treina o time a ignorar a página.
  const confirmed = instant === STATUS.FAIL && anyBad && previousBad;

  const report = {
    schemaVersion: 3,
    generatedAt: startedAt.toISOString(),
    durationMs: Date.now() - t0,
    target: {
      name: CONFIG.app.name,
      url: CONFIG.app.baseUrl,
      alternateUrls: CONFIG.app.alternateUrls,
      supabaseRef: refOf(CONFIG.supabase.url),
    },
    authenticated: !!session.ok,
    monitorFault,
    monitorFaultReason: monitorFault ? scrub(session.reason) : null,
    runnerNetwork: self,
    buildFingerprint: frontend?.meta?.buildFingerprint ?? null,
    rootCause: rootCause.summary,
    overall: {
      status: instant,
      confirmed,
      alarm: confirmed,
      label: overallLabel(instant, monitorFault),
      summary: buildSummary(graded, instant, { monitorFault, confirmed, rootCause: rootCause.summary }),
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

  await writeReport(report);
  const fullHistory = await appendHistory(report);
  await fs.writeFile(path.join(DATA_DIR, 'incidents.json'), JSON.stringify(buildIncidents(fullHistory), null, 2) + '\n');

  log(`Concluído em ${((Date.now() - t0) / 1000).toFixed(1)}s — status: ${instant.toUpperCase()}${confirmed ? ' (CONFIRMADO)' : ''}`);
  for (const s of report.sections) log(`  ${icon(s.status)} ${s.label}: ${s.detail || s.status}`);

  // O resultado do sistema monitorado nunca falha o job: a página precisa ser
  // publicada justamente quando algo está vermelho. O alarme é decidido no
  // workflow, a partir de overall.alarm.
  process.exit(0);
}

/* ------------------------------------------------------- causa raiz */

/**
 * Numa queda do Supabase, a versão anterior pintava 3 seções e 14 itens de
 * vermelho — parede de vermelho, zero diagnóstico. Aqui, quando o núcleo do
 * backend cai, o resto vira "não verificável" e a causa raiz é nomeada.
 */
function suppressCascade(sections) {
  const backend = sections.find((s) => s.key === 'backend');
  const core = ['auth', 'postgrest', 'system-health'];
  const coreItems = (backend?.items || []).filter((i) => core.includes(i.key));
  const supabaseDown = coreItems.length === core.length && coreItems.every((i) => i.status === STATUS.FAIL);

  if (!supabaseDown) return { sections, summary: null };

  const downgraded = sections.map((s) => {
    if (s.key !== 'edge' && s.key !== 'experience') return s;
    if (s.status === STATUS.OK) return s;
    return {
      ...s,
      status: STATUS.UNKNOWN,
      detail: 'não verificável — o Supabase está fora do ar (causa raiz acima)',
      items: (s.items || []).map((i) => (i.status === STATUS.OK ? i : { ...i, status: STATUS.UNKNOWN })),
    };
  });

  return { sections: downgraded, summary: 'Supabase indisponível — as demais falhas são consequência disso.' };
}

/* ------------------------------------------------------- utilidades */

async function safe(key, label, fn) {
  try {
    return await fn();
  } catch (err) {
    return {
      key, label,
      status: STATUS.UNKNOWN,
      latencyMs: null,
      items: [],
      detail: `checagem não pôde ser executada: ${scrub(err?.message || String(err))}`,
      meta: { error: true },
    };
  }
}

function skippedSection(key, label, detail) {
  return { key, label, status: STATUS.SKIPPED, latencyMs: null, items: [], detail, meta: {} };
}

function withDetail(section) {
  if (section.detail) return section;
  const items = section.items || [];
  const bad = items.filter((i) => !i.informational && i.status !== STATUS.OK && i.status !== STATUS.SKIPPED);
  return { ...section, detail: bad.length ? bad.map((b) => b.label).join(' · ') : `${items.length} verificação(ões) OK` };
}

function buildSummary(sections, overall, { monitorFault, confirmed, rootCause }) {
  if (rootCause) return rootCause;
  if (monitorFault) {
    return 'O monitor não conseguiu autenticar com o usuário dedicado. Isto é um problema de configuração do monitor, não necessariamente do PrimeDoctor.';
  }
  if (overall === STATUS.OK) return 'Todos os sistemas verificados responderam normalmente.';

  const fails = sections.filter((s) => s.status === STATUS.FAIL);
  const warns = sections.filter((s) => s.status === STATUS.DEGRADED);
  const gaps = sections.filter((s) => s.status === STATUS.SKIPPED || s.status === STATUS.UNKNOWN);

  const parts = [];
  if (fails.length) parts.push(`Falha em: ${fails.map((s) => s.label.toLowerCase()).join(', ')}`);
  if (warns.length) parts.push(`Degradação em: ${warns.map((s) => s.label.toLowerCase()).join(', ')}`);
  if (gaps.length) parts.push(`Não verificado: ${gaps.map((s) => s.label.toLowerCase()).join(', ')}`);
  if (fails.length && !confirmed) {
    parts.push('Primeira execução ruim — aguardando a próxima para confirmar (evita alarme falso)');
  }
  return parts.join('. ') + '.';
}

function overallLabel(s, monitorFault) {
  if (monitorFault) return 'Monitor mal configurado';
  return {
    ok: 'Todos os sistemas operacionais',
    degraded: 'Desempenho degradado',
    fail: 'Falha detectada',
    unknown: 'Verificação parcial — não foi possível confirmar',
    skipped: 'Verificação parcial — checagens não executadas',
  }[s] || 'Estado indeterminado';
}

function buildOfflineReport(startedAt, t0, self) {
  return {
    schemaVersion: 3,
    generatedAt: startedAt.toISOString(),
    durationMs: Date.now() - t0,
    target: { name: CONFIG.app.name, url: CONFIG.app.baseUrl, alternateUrls: CONFIG.app.alternateUrls, supabaseRef: refOf(CONFIG.supabase.url) },
    authenticated: false,
    monitorFault: true,
    monitorFaultReason: 'o runner do monitor está sem acesso à rede',
    runnerNetwork: self,
    buildFingerprint: null,
    rootCause: 'O monitor está sem rede — não há informação sobre o PrimeDoctor nesta execução.',
    overall: {
      status: STATUS.UNKNOWN,
      confirmed: false,
      alarm: false,
      label: 'Sem informação — o monitor está sem rede',
      summary: 'Nenhum alvo de controle respondeu, então o monitor não tem autoridade para afirmar nada sobre o sistema. Isto NÃO significa que o PrimeDoctor está fora do ar.',
    },
    sections: [],
    runner: { source: process.env.GITHUB_ACTIONS ? 'github-actions' : 'local', runUrl: null },
  };
}

async function writeReport(report) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(path.join(DATA_DIR, 'status.json'), JSON.stringify(report, null, 2) + '\n');
}

/* --------------------------------------------------------- histórico */

async function readHistory() {
  try {
    const raw = await fs.readFile(HISTORY_FILE, 'utf8');
    return raw.split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Formato JSONL append-only. Um único JSON gigante reescrito de hora em hora
 * fazia o git gravar um blob novo por execução (~3 GB/ano) e conflitava em
 * qualquer escrita concorrente, porque era tudo uma linha só.
 */
async function appendHistory(report) {
  const sec = (k) => report.sections.find((s) => s.key === k);
  const item = (k, ik) => (sec(k)?.items || []).find((i) => i.key === ik);

  const entry = {
    t: report.generatedAt,
    s: report.overall.status,
    c: report.overall.confirmed ? 1 : 0,
    bd: report.sections.some((x) => !x.informational && isBad(x.status)) ? 1 : 0,
    f: sec('frontend')?.status ?? STATUS.UNKNOWN,
    b: sec('backend')?.status ?? STATUS.UNKNOWN,
    e: sec('edge')?.status ?? STATUS.UNKNOWN,
    x: sec('experience')?.status ?? STATUS.UNKNOWN,
    fp: report.buildFingerprint ? hash(report.buildFingerprint) : null,
    lat: {
      doc: item('frontend', 'document')?.latencyMs ?? null,
      db: item('backend', 'system-health')?.latencyMs ?? null,
      edge: sec('edge')?.latencyMs ?? null,
      load: item('experience', 'public.load')?.latencyMs ?? null,
      lcp: item('experience', 'public.lcp')?.latencyMs ?? null,
      login: item('experience', 'authed.components')?.latencyMs ?? null,
    },
    bad: badItemKeys(report),
  };

  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.appendFile(HISTORY_FILE, JSON.stringify(entry) + '\n');

  let history = await readHistory();
  // Rotação rara: só quando passa bem do teto, para preservar o delta do git.
  if (history.length > CONFIG.history.maxEntries * 1.2) {
    history = history.slice(history.length - CONFIG.history.maxEntries);
    await fs.writeFile(HISTORY_FILE, history.map((h) => JSON.stringify(h)).join('\n') + '\n');
  }
  return history;
}

function badItemKeys(report) {
  const keys = [];
  for (const s of report.sections) {
    if (s.informational) continue;
    for (const i of s.items || []) {
      if (i.informational) continue;
      if (i.status === STATUS.FAIL || i.status === STATUS.DEGRADED) keys.push(`${s.key}/${i.key}`);
    }
  }
  return keys.slice(0, 12);
}

/**
 * Agrupa execuções ruins consecutivas em incidentes.
 *
 * Duas correções sobre a versão anterior:
 *  - exige N execuções ruins (o mesmo N do alarme), como a página promete;
 *  - `unknown` no meio de uma queda NÃO fecha o incidente: perder visibilidade
 *    durante um incidente não é o incidente ter acabado. Antes, uma queda de
 *    6h virava três incidentes de 2h com durações erradas.
 */
function buildIncidents(history) {
  const incidents = [];
  let open = null;
  let pending = [];

  for (const h of history) {
    const bad = entryIsBad(h);
    const blind = !bad && !hasAnyHealthy(h);

    if (bad) {
      if (open) {
        open.checks += 1;
        if (h.s === STATUS.FAIL) open.worst = STATUS.FAIL;
        mergeInto(open, h);
      } else {
        pending.push(h);
        if (pending.length >= CONFIG.alarm.consecutiveBadRuns) {
          open = {
            startedAt: pending[0].t, endedAt: null, worst: STATUS.DEGRADED,
            checks: pending.length, areas: [], items: [], blindSpots: 0,
          };
          for (const p of pending) {
            if (p.s === STATUS.FAIL) open.worst = STATUS.FAIL;
            mergeInto(open, p);
          }
          pending = [];
        }
      }
    } else if (blind) {
      // Perder visibilidade durante uma queda não é a queda ter acabado.
      if (open) { open.checks += 1; open.blindSpots += 1; }
    } else {
      if (open) { open.endedAt = h.t; incidents.push(open); open = null; }
      pending = [];
    }
  }
  if (open) incidents.push(open);

  return incidents
    .reverse()
    .slice(0, 50)
    .map((i) => ({
      ...i,
      durationMinutes: i.endedAt ? Math.round((new Date(i.endedAt) - new Date(i.startedAt)) / 60000) : null,
    }));
}

/** Alguma área graduada estava em falha/degradação nesta execução? */
function entryIsBad(h) {
  if (typeof h.bd === 'number') return h.bd === 1;
  return ['f', 'b', 'e', 'x'].some((k) => isBad(h[k])); // histórico antigo
}

/** Alguma área respondeu OK? Serve para distinguir "voltou" de "ficamos cegos". */
function hasAnyHealthy(h) {
  return ['f', 'b', 'e', 'x'].some((k) => h[k] === STATUS.OK);
}

function mergeInto(incident, h) {
  for (const a of areasOf(h)) if (!incident.areas.includes(a)) incident.areas.push(a);
  for (const k of h.bad || []) if (!incident.items.includes(k)) incident.items.push(k);
  incident.items = incident.items.slice(0, 15);
}

function areasOf(h) {
  const names = { f: 'front-end', b: 'backend', e: 'integrações', x: 'carregamento' };
  return Object.entries(names).filter(([k]) => isBad(h[k])).map(([, v]) => v);
}

function hash(text) {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (Math.imul(31, h) + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16).padStart(8, '0');
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
