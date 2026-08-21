import { chromium } from 'playwright';
import { CONFIG, STATUS, worstStatus, statusFromLatency } from '../config.mjs';
import { sanitize } from './backend.mjs';

const T = CONFIG.thresholds;

// Ruído conhecido que não indica problema de saúde do sistema.
const IGNORED_CONSOLE = [
  /Download the React DevTools/i,
  /\[vite\]/i,
  /Lit is in dev mode/i,
  /third-party cookie/i,
  /Tracking Prevention/i,
];

/**
 * Carrega o app num Chromium real e mede o que o usuário de verdade sente:
 * tempo até a tela aparecer, se os componentes montaram, erros no console
 * e requisições que falharam.
 */
export async function checkBrowser(session) {
  let browser;
  const sections = [];
  try {
    browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  } catch (err) {
    return {
      key: 'experience',
      label: 'Experiência de carregamento',
      status: STATUS.UNKNOWN,
      latencyMs: null,
      items: [],
      detail: `não foi possível iniciar o navegador: ${err.message}`,
      meta: {},
    };
  }

  try {
    // ---------- 1. Tela pública de login ----------
    const publicRun = await measurePage(browser, CONFIG.app.baseUrl + CONFIG.app.publicRoute, {
      expect: async (page) => {
        const email = await page.locator('#signin-email, input[type="email"]').first().count();
        const pass = await page.locator('#signin-password, input[type="password"]').first().count();
        return {
          ok: email > 0 && pass > 0,
          detail: email > 0 && pass > 0 ? 'formulário de acesso renderizado' : 'formulário de acesso NÃO renderizou',
        };
      },
    });
    sections.push(...buildItems('public', 'Tela de acesso (pública)', publicRun));

    // ---------- 2. Área autenticada ----------
    if (!CONFIG.auth.email || !CONFIG.auth.password) {
      sections.push({
        key: 'authed',
        label: 'Área autenticada',
        status: STATUS.SKIPPED,
        latencyMs: null,
        detail: 'usuário-monitor não configurado — checagem interna desativada',
        meta: {},
      });
    } else if (!session?.ok) {
      sections.push({
        key: 'authed',
        label: 'Área autenticada',
        status: STATUS.FAIL,
        latencyMs: null,
        detail: `login falhou na API: ${sanitize(session?.reason) || 'motivo desconhecido'}`,
        meta: {},
      });
    } else {
      const authedRun = await measureLogin(browser);
      sections.push(...buildItems('authed', 'Área autenticada', authedRun));
    }
  } finally {
    await browser.close().catch(() => {});
  }

  const load = sections.find((s) => s.key === 'public.load');
  return {
    key: 'experience',
    label: 'Experiência de carregamento',
    status: worstStatus(sections.map((s) => s.status)),
    latencyMs: load?.latencyMs ?? null,
    items: sections,
    meta: {},
  };
}

/** Abre uma página, coleta métricas de performance, console e rede. */
async function measurePage(browser, url, { expect, prepare } = {}) {
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

  page.on('console', (msg) => {
    if (msg.type() !== 'error' && msg.type() !== 'warning') return;
    const text = msg.text();
    if (IGNORED_CONSOLE.some((re) => re.test(text))) return;
    if (msg.type() === 'error') consoleErrors.push(sanitize(text));
  });
  page.on('pageerror', (err) => pageErrors.push(sanitize(err.message)));
  page.on('requestfailed', (req) => {
    failedRequests.push({ url: shortUrl(req.url()), reason: req.failure()?.errorText || 'falhou' });
  });
  page.on('response', (res) => {
    const u = res.url();
    if (res.status() >= 400 && !u.startsWith('data:')) {
      failedRequests.push({ url: shortUrl(u), reason: `HTTP ${res.status()}` });
    }
    const type = res.request().resourceType();
    if (type === 'script' || type === 'stylesheet') {
      resources.push({ url: shortUrl(u), type, status: res.status() });
    }
  });

  const result = {
    url,
    navOk: false,
    navError: null,
    timings: {},
    webVitals: {},
    consoleErrors,
    pageErrors,
    failedRequests,
    resources,
    expectation: null,
    domNodes: 0,
  };

  try {
    if (prepare) await prepare(page, context);

    await page.addInitScript(() => {
      window.__pdVitals = { lcp: null, cls: 0, fcp: null };
      try {
        new PerformanceObserver((l) => {
          const e = l.getEntries();
          if (e.length) window.__pdVitals.lcp = Math.round(e[e.length - 1].startTime);
        }).observe({ type: 'largest-contentful-paint', buffered: true });
        new PerformanceObserver((l) => {
          for (const entry of l.getEntries()) {
            if (!entry.hadRecentInput) window.__pdVitals.cls += entry.value;
          }
        }).observe({ type: 'layout-shift', buffered: true });
        new PerformanceObserver((l) => {
          for (const entry of l.getEntries()) {
            if (entry.name === 'first-contentful-paint') window.__pdVitals.fcp = Math.round(entry.startTime);
          }
        }).observe({ type: 'paint', buffered: true });
      } catch (e) { /* navegador sem suporte */ }
    });

    const t0 = Date.now();
    const response = await page.goto(url, { waitUntil: 'load', timeout: CONFIG.timeouts.browser });
    result.httpStatus = response?.status() ?? 0;
    result.navOk = !!response && response.status() < 400;

    // Espera o app efetivamente montar (React pinta depois do "load").
    await page
      .waitForFunction(() => document.querySelector('#root')?.childElementCount > 0, null, { timeout: 25000 })
      .catch(() => {});
    result.timeToAppMs = Date.now() - t0;

    // Deixa o LCP estabilizar.
    await page.waitForTimeout(1200);

    result.timings = await page.evaluate(() => {
      const n = performance.getEntriesByType('navigation')[0];
      if (!n) return {};
      const r = (v) => (v == null ? null : Math.round(v));
      return {
        dnsMs: r(n.domainLookupEnd - n.domainLookupStart),
        tcpMs: r(n.connectEnd - n.connectStart),
        tlsMs: n.secureConnectionStart ? r(n.connectEnd - n.secureConnectionStart) : null,
        ttfbMs: r(n.responseStart - n.requestStart),
        downloadMs: r(n.responseEnd - n.responseStart),
        domContentLoadedMs: r(n.domContentLoadedEventEnd - n.startTime),
        loadMs: r(n.loadEventEnd - n.startTime),
        transferBytes: n.transferSize || 0,
      };
    });

    result.webVitals = await page.evaluate(() => ({
      lcpMs: window.__pdVitals?.lcp ?? null,
      fcpMs: window.__pdVitals?.fcp ?? null,
      cls: window.__pdVitals?.cls != null ? Math.round(window.__pdVitals.cls * 1000) / 1000 : null,
    }));

    result.domNodes = await page.evaluate(() => document.querySelectorAll('*').length);

    if (expect) result.expectation = await expect(page).catch((e) => ({ ok: false, detail: sanitize(e.message) }));
  } catch (err) {
    result.navError = sanitize(err.message);
  } finally {
    await context.close().catch(() => {});
  }

  return result;
}

/** Faz login pelo formulário real e confere se o app interno monta. */
async function measureLogin(browser) {
  return measurePage(browser, CONFIG.app.baseUrl + CONFIG.app.publicRoute, {
    expect: async (page) => {
      const t0 = Date.now();
      await page.fill('#signin-email, input[type="email"]', CONFIG.auth.email);
      await page.fill('#signin-password, input[type="password"]', CONFIG.auth.password);
      await page.click('form button[type="submit"]');

      // Sucesso = saiu da tela de login (o formulário some).
      const left = await page
        .waitForFunction(() => !document.querySelector('#signin-password'), null, { timeout: 40000 })
        .then(() => true)
        .catch(() => false);

      if (!left) {
        const msg = await page
          .locator('.text-destructive')
          .first()
          .textContent()
          .catch(() => null);
        return { ok: false, detail: `login não concluiu${msg ? `: ${sanitize(msg.trim())}` : ' em 40s'}`, ms: Date.now() - t0 };
      }

      // Confere que a aplicação interna renderizou conteúdo de verdade.
      const mounted = await page
        .waitForFunction(() => (document.querySelector('#root')?.textContent || '').trim().length > 120, null, {
          timeout: 30000,
        })
        .then(() => true)
        .catch(() => false);

      return {
        ok: mounted,
        ms: Date.now() - t0,
        detail: mounted
          ? `login e carregamento da área interna em ${((Date.now() - t0) / 1000).toFixed(1)}s`
          : 'login OK mas a área interna ficou em branco',
      };
    },
  });
}

/** Converte uma medição bruta em itens de status legíveis. */
function buildItems(prefix, label, run) {
  const items = [];
  const vitals = run.webVitals || {};
  const timings = run.timings || {};

  // Carregamento
  const loadMs = run.timeToAppMs ?? timings.loadMs ?? null;
  let loadStatus;
  let loadDetail;
  if (run.navError) {
    loadStatus = STATUS.FAIL;
    loadDetail = `não carregou: ${run.navError}`;
  } else if (!run.navOk) {
    loadStatus = STATUS.FAIL;
    loadDetail = `servidor respondeu HTTP ${run.httpStatus}`;
  } else {
    loadStatus = statusFromLatency(loadMs ?? 0, T.pageLoadWarn, T.pageLoadFail);
    loadDetail = `app pronto em ${fmtSec(loadMs)}${timings.ttfbMs != null ? ` · TTFB ${timings.ttfbMs}ms` : ''}`;
  }
  items.push({
    key: `${prefix}.load`,
    label: `${label} — tempo de carregamento`,
    status: loadStatus,
    latencyMs: loadMs,
    detail: loadDetail,
    meta: { ...timings, ...vitals, domNodes: run.domNodes },
  });

  // Percepção visual (LCP)
  if (vitals.lcpMs != null) {
    items.push({
      key: `${prefix}.lcp`,
      label: `${label} — primeira tela visível`,
      status: statusFromLatency(vitals.lcpMs, T.lcpWarn, T.lcpFail),
      latencyMs: vitals.lcpMs,
      detail: `maior elemento pintado em ${fmtSec(vitals.lcpMs)}${
        vitals.fcpMs != null ? ` · primeiro conteúdo em ${fmtSec(vitals.fcpMs)}` : ''
      }`,
      meta: { cls: vitals.cls },
    });
  }

  // Componentes montados
  if (run.expectation) {
    items.push({
      key: `${prefix}.components`,
      label: `${label} — componentes montados`,
      status: run.expectation.ok ? STATUS.OK : STATUS.FAIL,
      latencyMs: run.expectation.ms ?? null,
      detail: run.expectation.detail,
      meta: {},
    });
  }

  // Erros de JavaScript
  const errs = [...new Set([...(run.pageErrors || []), ...(run.consoleErrors || [])])];
  items.push({
    key: `${prefix}.errors`,
    label: `${label} — erros de JavaScript`,
    status: run.pageErrors?.length ? STATUS.FAIL : errs.length ? STATUS.DEGRADED : STATUS.OK,
    latencyMs: null,
    detail: errs.length ? `${errs.length} erro(s) no console` : 'nenhum erro no console',
    meta: { samples: errs.slice(0, 5) },
  });

  // Recursos que falharam
  const failed = dedupeRequests(run.failedRequests || []);
  const scripts = (run.resources || []).filter((r) => r.type === 'script');
  items.push({
    key: `${prefix}.resources`,
    label: `${label} — recursos carregados`,
    status: failed.length === 0 ? STATUS.OK : failed.length <= 2 ? STATUS.DEGRADED : STATUS.FAIL,
    latencyMs: null,
    detail:
      failed.length === 0
        ? `${scripts.length} script(s) carregados, nenhuma requisição falhou`
        : `${failed.length} requisição(ões) falharam`,
    meta: { failed: failed.slice(0, 8), scriptCount: scripts.length },
  });

  return items;
}

function dedupeRequests(list) {
  const seen = new Map();
  for (const f of list) {
    const k = `${f.url}|${f.reason}`;
    if (!seen.has(k)) seen.set(k, f);
  }
  return [...seen.values()];
}

function shortUrl(u) {
  try {
    const parsed = new URL(u);
    // Remove query string: pode conter tokens.
    return parsed.origin + parsed.pathname;
  } catch {
    return String(u).split('?')[0].slice(0, 160);
  }
}

function fmtSec(ms) {
  if (ms == null) return '—';
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(2)}s`;
}
