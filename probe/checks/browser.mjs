import { chromium } from 'playwright';
import { CONFIG, STATUS, worstStatus, statusFromLatency } from '../config.mjs';
import { scrub, summarizeErrors, safeUrl } from '../lib/sanitize.mjs';

const T = CONFIG.thresholds;

// Ruído conhecido que não diz nada sobre a saúde do sistema.
const IGNORED_CONSOLE = [
  /Download the React DevTools/i,
  /\[vite\]/i,
  /Lit is in dev mode/i,
  /third-party cookie/i,
  /Tracking Prevention/i,
  /ResizeObserver loop/i,
  /chrome-extension:/i,
  /favicon/i,
];

/**
 * Carrega o app num Chromium real e mede o que o usuário de verdade sente.
 *
 * Duas decisões deliberadas:
 *
 * 1. ERRO DE JAVASCRIPT NÃO DERRUBA O STATUS. O app tem centenas de
 *    `console.error` legítimos e SPAs disparam exceções benignas o tempo todo
 *    (fetch abortado em unmount, SDK de terceiro). Tratar isso como falha
 *    garante vermelho permanente — e uma página vermelha permanente é uma
 *    página que ninguém abre. Os erros são reportados como INFORMATIVOS.
 *
 * 2. SELETOR NÃO ENCONTRADO ≠ SISTEMA QUEBRADO. Se o formulário de login mudou
 *    de id, a sonda está desatualizada, não a produção. Esse caso vira
 *    "indeterminado", com texto dizendo para corrigir a sonda.
 */
export async function checkBrowser(session) {
  let browser;
  try {
    browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  } catch (err) {
    return unknownSection(`não foi possível iniciar o navegador: ${scrub(err.message)}`);
  }

  const sections = [];
  try {
    // ---------- 1. Tela pública de login ----------
    const publicRun = await measurePage(browser, CONFIG.app.baseUrl + CONFIG.app.publicRoute, {
      expect: async (page) => {
        const email = await page.locator('#signin-email, input[type="email"]').first().count();
        const pass = await page.locator('#signin-password, input[type="password"]').first().count();
        if (email > 0 && pass > 0) return { ok: true, detail: 'formulário de acesso renderizado' };
        // Distingue "app não montou" de "app montou mas mudou de layout".
        const mounted = await page.evaluate(() => (document.querySelector('#root')?.textContent || '').trim().length);
        return mounted > 80
          ? { unknown: true, detail: 'o app montou, mas o formulário esperado não foi encontrado — sonda possivelmente desatualizada' }
          : { ok: false, detail: 'o app não renderizou o formulário de acesso' };
      },
    });
    sections.push(...buildItems('public', 'Tela de acesso', publicRun, { includeTiming: true }));

    // ---------- 2. Login e área interna ----------
    if (session?.skipped) {
      sections.push({
        key: 'authed.flow',
        label: 'Login e área interna',
        status: STATUS.SKIPPED,
        latencyMs: null,
        detail: 'usuário-monitor não configurado — o fluxo interno não foi verificado',
        meta: {},
      });
    } else if (session?.monitorFault) {
      sections.push({
        key: 'authed.flow',
        label: 'Login e área interna',
        status: STATUS.UNKNOWN,
        monitorFault: true,
        latencyMs: null,
        detail: `credencial do monitor recusada (${scrub(session.reason)}) — corrija os secrets; isto não indica falha do produto`,
        meta: {},
      });
    } else if (!session?.ok) {
      sections.push({
        key: 'authed.flow',
        label: 'Login e área interna',
        status: STATUS.FAIL,
        latencyMs: null,
        detail: `o serviço de autenticação recusou o login: ${scrub(session?.reason) || 'motivo desconhecido'}`,
        meta: {},
      });
    } else {
      const authedRun = await measureLogin(browser);
      sections.push(...buildItems('authed', 'Login e área interna', authedRun, { includeTiming: false }));
    }
  } catch (err) {
    sections.push({
      key: 'browser.error',
      label: 'Verificação com navegador',
      status: STATUS.UNKNOWN,
      latencyMs: null,
      detail: `a sonda de navegador falhou: ${scrub(err.message)}`,
      meta: {},
    });
  } finally {
    await browser.close().catch(() => {});
  }

  // Itens informativos (erros de console) não entram no cálculo do status.
  const graded = sections.filter((s) => !s.informational);
  const load = sections.find((s) => s.key === 'public.load');

  return {
    key: 'experience',
    label: 'Experiência de carregamento',
    status: worstStatus(graded.map((s) => s.status)),
    latencyMs: load?.latencyMs ?? null,
    items: sections,
    meta: {},
  };
}

function unknownSection(detail) {
  return {
    key: 'experience',
    label: 'Experiência de carregamento',
    status: STATUS.UNKNOWN,
    latencyMs: null,
    items: [],
    detail,
    meta: {},
  };
}

/** Abre uma página, coleta métricas de performance, console e rede. */
async function measurePage(browser, url, { expect } = {}) {
  const context = await browser.newContext({
    viewport: { width: 1366, height: 900 },
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 PrimeDoctorHealthMonitor/1.0',
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
  });
  const page = await context.newPage();

  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];
  const resources = [];
  const origin = new URL(url).origin;

  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    if (IGNORED_CONSOLE.some((re) => re.test(text))) return;
    consoleErrors.push(text);
  });
  page.on('pageerror', (err) => {
    if (IGNORED_CONSOLE.some((re) => re.test(err.message))) return;
    pageErrors.push(err.message);
  });
  page.on('requestfailed', (req) => {
    failedRequests.push({
      url: safeUrl(req.url()),
      type: req.resourceType(),
      reason: scrub(req.failure()?.errorText) || 'falhou',
      sameOrigin: req.url().startsWith(origin),
    });
  });
  page.on('response', (res) => {
    const u = res.url();
    const type = res.request().resourceType();
    if (res.status() >= 400 && !u.startsWith('data:')) {
      failedRequests.push({ url: safeUrl(u), type, reason: `HTTP ${res.status()}`, sameOrigin: u.startsWith(origin) });
    }
    if (type === 'script' || type === 'stylesheet') {
      resources.push({ url: safeUrl(u), type, status: res.status() });
    }
  });

  const result = {
    url, navOk: false, navError: null, httpStatus: 0,
    timings: {}, webVitals: {}, consoleErrors, pageErrors, failedRequests, resources,
    expectation: null, domNodes: 0, timeToAppMs: null,
  };

  try {
    await page.addInitScript(() => {
      window.__pdVitals = { lcp: null, cls: 0, fcp: null };
      try {
        new PerformanceObserver((l) => {
          const e = l.getEntries();
          if (e.length) window.__pdVitals.lcp = Math.round(e[e.length - 1].startTime);
        }).observe({ type: 'largest-contentful-paint', buffered: true });
        new PerformanceObserver((l) => {
          for (const entry of l.getEntries()) if (!entry.hadRecentInput) window.__pdVitals.cls += entry.value;
        }).observe({ type: 'layout-shift', buffered: true });
        new PerformanceObserver((l) => {
          for (const entry of l.getEntries()) {
            if (entry.name === 'first-contentful-paint') window.__pdVitals.fcp = Math.round(entry.startTime);
          }
        }).observe({ type: 'paint', buffered: true });
      } catch { /* navegador sem suporte */ }
    });

    const t0 = Date.now();
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: CONFIG.timeouts.browser });
    result.httpStatus = response?.status() ?? 0;
    result.navOk = !!response && response.status() < 400;

    // O que importa não é o evento "load" (que espera fonte e analytics),
    // e sim o app estar montado e com conteúdo na tela.
    const mounted = await page
      .waitForFunction(() => (document.querySelector('#root')?.textContent || '').trim().length > 40, null, { timeout: 25000 })
      .then(() => true)
      .catch(() => false);
    result.timeToAppMs = mounted ? Date.now() - t0 : null;
    result.mounted = mounted;

    await page.waitForTimeout(1200); // deixa o LCP estabilizar

    result.timings = await page.evaluate(() => {
      const n = performance.getEntriesByType('navigation')[0];
      if (!n) return {};
      const r = (v) => (v == null || Number.isNaN(v) ? null : Math.round(v));
      return {
        dnsMs: r(n.domainLookupEnd - n.domainLookupStart),
        tcpMs: r(n.connectEnd - n.connectStart),
        ttfbMs: r(n.responseStart - n.requestStart),
        downloadMs: r(n.responseEnd - n.responseStart),
        domContentLoadedMs: r(n.domContentLoadedEventEnd - n.startTime),
        transferBytes: n.transferSize || 0,
      };
    });

    result.webVitals = await page.evaluate(() => ({
      lcpMs: window.__pdVitals?.lcp ?? null,
      fcpMs: window.__pdVitals?.fcp ?? null,
      cls: window.__pdVitals?.cls != null ? Math.round(window.__pdVitals.cls * 1000) / 1000 : null,
    }));

    result.domNodes = await page.evaluate(() => document.querySelectorAll('*').length);

    if (expect) {
      result.expectation = await expect(page).catch((e) => ({ unknown: true, detail: `a asserção falhou: ${scrub(e.message)}` }));
    }
  } catch (err) {
    result.navError = scrub(err.message);
  } finally {
    await context.close().catch(() => {});
  }

  return result;
}

/** Faz login pelo formulário real e confere se o app interno monta. */
async function measureLogin(browser) {
  return measurePage(browser, CONFIG.app.baseUrl + CONFIG.app.publicRoute, {
    expect: async (page) => {
      const emailField = page.locator('#signin-email, input[type="email"]').first();
      const passField = page.locator('#signin-password, input[type="password"]').first();
      const submit = page.locator('form button[type="submit"]').first();

      if ((await emailField.count()) === 0 || (await passField.count()) === 0 || (await submit.count()) === 0) {
        return { unknown: true, detail: 'formulário de login não encontrado — sonda desatualizada, não falha do produto' };
      }

      const t0 = Date.now();
      await emailField.fill(CONFIG.auth.email);
      await passField.fill(CONFIG.auth.password);
      await submit.click();

      const left = await page
        .waitForFunction(() => !document.querySelector('#signin-password'), null, { timeout: 35000 })
        .then(() => true)
        .catch(() => false);

      if (!left) {
        const msg = await page.locator('.text-destructive').first().textContent().catch(() => null);
        return { ok: false, ms: Date.now() - t0, detail: `login não concluiu${msg ? `: ${scrub(msg)}` : ' em 35s'}` };
      }

      const mounted = await page
        .waitForFunction(() => (document.querySelector('#root')?.textContent || '').trim().length > 150, null, { timeout: 30000 })
        .then(() => true)
        .catch(() => false);

      const ms = Date.now() - t0;
      return {
        ok: mounted,
        ms,
        detail: mounted
          ? `login e carregamento da área interna em ${(ms / 1000).toFixed(1)}s`
          : 'login aceito, mas a área interna ficou em branco',
      };
    },
  });
}

/** Converte uma medição bruta em itens de status legíveis. */
function buildItems(prefix, label, run, { includeTiming }) {
  const items = [];
  const vitals = run.webVitals || {};
  const timings = run.timings || {};

  if (includeTiming) {
    const loadMs = run.timeToAppMs;
    let status;
    let detail;
    if (run.navError) {
      status = STATUS.FAIL;
      detail = `não carregou: ${run.navError}`;
    } else if (!run.navOk) {
      status = STATUS.FAIL;
      detail = `o servidor respondeu HTTP ${run.httpStatus}`;
    } else if (!run.mounted) {
      status = STATUS.FAIL;
      detail = 'a página carregou mas o app não montou nada na tela em 25s';
    } else {
      status = statusFromLatency(loadMs, T.pageLoadWarn, T.pageLoadFail);
      detail = `app pronto em ${fmtSec(loadMs)}${timings.ttfbMs != null ? ` · TTFB ${timings.ttfbMs}ms` : ''}`;
    }
    items.push({
      key: `${prefix}.load`,
      label: `${label} — tempo até o app aparecer`,
      status,
      latencyMs: loadMs,
      detail,
      meta: { ...timings, ...vitals, domNodes: run.domNodes },
    });

    if (vitals.lcpMs != null) {
      items.push({
        key: `${prefix}.lcp`,
        label: `${label} — primeira tela visível`,
        status: statusFromLatency(vitals.lcpMs, T.lcpWarn, T.lcpFail),
        latencyMs: vitals.lcpMs,
        detail: `maior elemento pintado em ${fmtSec(vitals.lcpMs)}${vitals.fcpMs != null ? ` · primeiro conteúdo em ${fmtSec(vitals.fcpMs)}` : ''}`,
        meta: { cls: vitals.cls },
      });
    }
  }

  // Asserção funcional (formulário renderizado / login concluído).
  if (run.expectation) {
    const e = run.expectation;
    items.push({
      key: `${prefix}.components`,
      label: `${label} — componentes montados`,
      status: e.unknown ? STATUS.UNKNOWN : e.ok ? STATUS.OK : STATUS.FAIL,
      latencyMs: e.ms ?? null,
      detail: e.detail,
      meta: {},
    });
  } else if (run.navError) {
    items.push({
      key: `${prefix}.components`,
      label: `${label} — componentes montados`,
      status: STATUS.FAIL,
      latencyMs: null,
      detail: `não foi possível avaliar: ${run.navError}`,
      meta: {},
    });
  }

  // ERROS DE JAVASCRIPT — informativo, nunca define o status geral.
  // Publicamos apenas categoria + contagem: o texto integral pode conter
  // telefone de paciente e este repositório é público e permanente.
  const allErrors = [...run.pageErrors, ...run.consoleErrors];
  const categories = summarizeErrors(allErrors);
  items.push({
    key: `${prefix}.errors`,
    label: `${label} — erros de JavaScript`,
    informational: true,
    status: allErrors.length === 0 ? STATUS.OK : STATUS.DEGRADED,
    latencyMs: null,
    detail: allErrors.length === 0
      ? 'nenhum erro no console'
      : `${allErrors.length} erro(s) em ${categories.length} categoria(s) — informativo, não afeta o status geral`,
    meta: { categories, total: allErrors.length },
  });

  // Recursos: julga por criticidade, não por contagem bruta.
  const failed = dedupe(run.failedRequests);
  const critical = failed.filter((f) => ['document', 'script', 'stylesheet'].includes(f.type));
  const apiFailures = failed.filter((f) => f.type === 'fetch' || f.type === 'xhr');
  const scripts = run.resources.filter((r) => r.type === 'script');
  items.push({
    key: `${prefix}.resources`,
    label: `${label} — recursos carregados`,
    status: critical.length > 0 ? STATUS.FAIL : apiFailures.length > 2 ? STATUS.DEGRADED : STATUS.OK,
    latencyMs: null,
    detail: critical.length > 0
      ? `${critical.length} recurso(s) essenciais não carregaram (script/estilo/documento)`
      : apiFailures.length > 0
        ? `${scripts.length} script(s) OK · ${apiFailures.length} chamada(s) de API falharam`
        : `${scripts.length} script(s) carregados, nada essencial falhou`,
    meta: { failed: failed.slice(0, 8), scriptCount: scripts.length },
  });

  return items;
}

function dedupe(list) {
  const seen = new Map();
  for (const f of list) {
    const k = `${f.url}|${f.reason}`;
    if (!seen.has(k)) seen.set(k, f);
  }
  return [...seen.values()];
}

function fmtSec(ms) {
  if (ms == null) return '—';
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(2)}s`;
}
