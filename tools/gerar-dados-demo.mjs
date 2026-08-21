// Gera data/*.json sintéticos para conferir o visual da página sem esperar
// dias de histórico real. NÃO usar em produção — o workflow sobrescreve tudo.
//   node tools/gerar-dados-demo.mjs [--out demo-data]
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outArg = process.argv.indexOf('--out');
const OUT = path.join(ROOT, outArg > -1 ? process.argv[outArg + 1] : 'data');

const HOURS = 24 * 14;
const now = Date.now();
const history = [];

const FP_ANTIGO = 'a1b2c3d4';
const FP_NOVO = 'e5f6a7b8';

for (let i = HOURS - 1; i >= 0; i--) {
  const t = new Date(now - i * 3600_000).toISOString();
  const queda = i > 96 && i < 101;   // indisponibilidade
  const lento = i > 40 && i < 46;    // degradação
  const cego = i === 70;             // execução sem visibilidade
  const f = queda ? 'fail' : cego ? 'unknown' : 'ok';
  const b = queda ? 'fail' : lento ? 'degraded' : cego ? 'unknown' : 'ok';
  const e = queda ? 'unknown' : cego ? 'unknown' : 'ok';
  const x = queda ? 'fail' : lento ? 'degraded' : cego ? 'unknown' : 'ok';
  const areas = [f, b, e, x];
  const s = areas.includes('fail') ? 'fail' : areas.includes('degraded') ? 'degraded' : cego ? 'unknown' : 'ok';
  const bd = areas.some((v) => v === 'fail' || v === 'degraded') ? 1 : 0;
  const j = (base, amp) => Math.round(base + Math.sin(i / 3.7) * amp + Math.random() * amp);

  history.push({
    t, s, c: queda && i < 100 ? 1 : 0, bd, f, b, e, x,
    fp: i > 30 ? FP_ANTIGO : FP_NOVO,
    lat: {
      doc: queda ? null : j(220, 70),
      db: queda ? null : lento ? j(1400, 300) : j(310, 90),
      edge: queda ? null : j(480, 140),
      load: queda ? null : lento ? j(7200, 900) : j(2600, 500),
      lcp: queda ? null : j(1700, 400),
      login: queda ? null : j(3400, 700),
    },
  });
}

const status = {
  schemaVersion: 3,
  generatedAt: new Date(now).toISOString(),
  durationMs: 78230,
  target: {
    name: 'PrimeDoctor',
    url: 'https://primedoctor.app',
    alternateUrls: ['https://primedoctor.primemedicalgo.com.br'],
    supabaseRef: 'iewdxiggqwyjdqbtmojm',
  },
  authenticated: true,
  monitorFault: false,
  monitorFaultReason: null,
  runnerNetwork: { networkOk: true, reachable: 2, total: 2, detail: '2/2 alvos de controle responderam' },
  buildFingerprint: 'index-9f3a21.css|index-b7e410.js|vendor-3c88ad.js',
  rootCause: null,
  overall: {
    status: 'degraded',
    confirmed: false,
    alarm: false,
    label: 'Desempenho degradado',
    summary: 'Degradação em: banco de dados e backend.',
  },
  sections: [
    {
      key: 'frontend', label: 'Hospedagem e front-end', status: 'ok', latencyMs: 214,
      detail: '7 verificação(ões) OK',
      items: [
        { key: 'dns', label: 'Resolução DNS', status: 'ok', latencyMs: 28, detail: '2 endereço(s) · primedoctor.app' },
        { key: 'tls', label: 'Certificado TLS', status: 'ok', latencyMs: 96, detail: 'válido · expira em 64 dia(s) · Google Trust Services', meta: { daysLeft: 64 } },
        { key: 'document', label: 'Documento HTML', status: 'ok', latencyMs: 214, detail: 'HTTP 200 · 2.3 kB · Cloudflare' },
        { key: 'bundles', label: 'Bundles do build (JS/CSS)', status: 'ok', latencyMs: 331, detail: '4 bundle(s) OK' },
        { key: 'static', label: 'Arquivos estáticos (manifest, favicon, robots)', status: 'ok', latencyMs: 118, detail: '3 arquivo(s) OK' },
        { key: 'spa-fallback', label: 'Roteamento SPA (link direto)', status: 'ok', latencyMs: 190, detail: 'rotas internas devolvem o app corretamente' },
        { key: 'alt:primedoctor.primemedicalgo.com.br', label: 'Domínio alternativo (primedoctor.primemedicalgo.com.br)', status: 'ok', latencyMs: 260, detail: 'no ar · TLS expira em 51 dia(s) · mesmo build do domínio principal' },
      ],
    },
    {
      key: 'backend', label: 'Banco de dados e backend', status: 'degraded', latencyMs: 402,
      detail: 'Consultas ao banco (com asserção de RLS)',
      items: [
        { key: 'supabase-tls', label: 'Certificado TLS do Supabase', status: 'ok', latencyMs: 88, detail: 'válido · expira em 120 dia(s) · Amazon' },
        { key: 'auth', label: 'Serviço de autenticação', status: 'ok', latencyMs: 141, detail: 'no ar · v2.180.0' },
        { key: 'postgrest', label: 'API do banco (PostgREST)', status: 'ok', latencyMs: 178, detail: 'no ar' },
        { key: 'system-health', label: 'Healthcheck do PrimeDoctor (banco)', status: 'ok', latencyMs: 402, detail: 'banco respondendo em 84ms' },
        {
          key: 'database', label: 'Consultas ao banco (com asserção de RLS)', status: 'degraded', latencyMs: 268,
          detail: '1 com problema: clinics',
          meta: { probes: [
            { table: 'profiles', status: 'ok', ms: 191, rows: 1, detail: '1 linha(s) visíveis em 191ms' },
            { table: 'clinic_members', status: 'ok', ms: 233, rows: 2, detail: '2 linha(s) visíveis em 233ms' },
            { table: 'clinics', status: 'degraded', ms: 1102, rows: 3, detail: '3 linha(s) visíveis em 1102ms' },
            { table: 'consultation_types', status: 'ok', ms: 244, rows: 18, detail: '18 linha(s) visíveis em 244ms' },
            { table: 'event_statuses', status: 'ok', ms: 210, rows: 9, detail: '9 linha(s) visíveis em 210ms' },
          ] },
        },
        { key: 'realtime', label: 'Realtime (tempo real)', status: 'ok', latencyMs: 388, detail: 'websocket conectado' },
        { key: 'storage', label: 'Armazenamento de arquivos', status: 'ok', latencyMs: 205, detail: 'serviço respondendo e acessível' },
      ],
    },
    {
      key: 'edge', label: 'Funções de borda (integrações)', status: 'ok', latencyMs: 452,
      detail: '7 função(ões) crítica(s) publicadas · 1 não crítica(s) com problema',
      items: [
        { key: '__canary__', label: 'Autoteste da sonda (canário 404)', critical: true, status: 'ok', latencyMs: 180, detail: 'slug inexistente devolveu 404 — a detecção está funcionando' },
        { key: 'system-health', label: 'Healthcheck do backend', critical: true, status: 'ok', latencyMs: 233, detail: 'publicada e roteável · HTTP 200' },
        { key: 'whatsapp-gateway', label: 'Gateway WhatsApp', critical: true, status: 'ok', latencyMs: 410, detail: 'publicada e roteável · HTTP 200' },
        { key: 'zapi-webhook', label: 'Webhook Z-API', critical: true, status: 'ok', latencyMs: 388, detail: 'publicada e roteável · HTTP 200' },
        { key: 'ai-engine', label: 'Motor de IA', critical: false, status: 'fail', latencyMs: null, detail: 'NÃO ENCONTRADA — a função sumiu do deploy' },
      ],
    },
    {
      key: 'experience', label: 'Experiência de carregamento', status: 'ok', latencyMs: 2480,
      detail: '6 verificação(ões) OK',
      items: [
        { key: 'public.load', label: 'Tela de acesso — tempo até o app aparecer', status: 'ok', latencyMs: 2480, detail: 'app pronto em 2.48s · TTFB 186ms' },
        { key: 'public.lcp', label: 'Tela de acesso — primeira tela visível', status: 'ok', latencyMs: 1640, detail: 'maior elemento pintado em 1.64s · primeiro conteúdo em 900ms' },
        { key: 'public.components', label: 'Tela de acesso — componentes montados', status: 'ok', latencyMs: null, detail: 'formulário de acesso renderizado' },
        {
          key: 'public.errors', label: 'Tela de acesso — erros de JavaScript', informational: true, status: 'degraded', latencyMs: null,
          detail: '3 erro(s) em 2 categoria(s) — informativo, não afeta o status geral',
          meta: { total: 3, categories: [
            { category: 'recurso-404', description: 'Um recurso pedido pelo app não existe', count: 2, distinct: 1 },
            { category: 'rede', description: 'Falha de rede numa requisição do app', count: 1, distinct: 1 },
          ] },
        },
        { key: 'public.resources', label: 'Tela de acesso — recursos carregados', status: 'ok', latencyMs: null, detail: '11 script(s) carregados, nada essencial falhou' },
        { key: 'authed.components', label: 'Login e área interna — componentes montados', status: 'ok', latencyMs: 3380, detail: 'login e carregamento da área interna em 3.4s' },
        { key: 'authed.errors', label: 'Login e área interna — erros de JavaScript', informational: true, status: 'ok', latencyMs: null, detail: 'nenhum erro no console' },
        { key: 'authed.resources', label: 'Login e área interna — recursos carregados', status: 'ok', latencyMs: null, detail: '23 script(s) carregados, nada essencial falhou' },
      ],
    },
    {
      key: 'upstream', label: 'Plataformas de terceiros', informational: true, status: 'degraded', latencyMs: null,
      detail: 'Cloudflare relatando incidente',
      items: [
        { key: 'supabase', label: 'Supabase', status: 'ok', latencyMs: 121, detail: 'All Systems Operational' },
        { key: 'lovable', label: 'Lovable', status: 'ok', latencyMs: 160, detail: 'All Systems Operational' },
        { key: 'cloudflare', label: 'Cloudflare', status: 'degraded', latencyMs: 98, detail: 'Partially Degraded Service' },
        { key: 'github', label: 'GitHub', status: 'ok', latencyMs: 88, detail: 'All Systems Operational' },
      ],
    },
  ],
  runner: { source: 'github-actions', runUrl: 'https://github.com/devhuander/primedoctor-monitor-saude/actions' },
};

const incidents = [
  {
    startedAt: new Date(now - 46 * 3600_000).toISOString(), endedAt: new Date(now - 40 * 3600_000).toISOString(),
    worst: 'degraded', checks: 5, blindSpots: 0,
    areas: ['backend', 'carregamento'], items: ['backend/database', 'experience/public.load'], durationMinutes: 360,
  },
  {
    startedAt: new Date(now - 101 * 3600_000).toISOString(), endedAt: new Date(now - 96 * 3600_000).toISOString(),
    worst: 'fail', checks: 5, blindSpots: 1,
    areas: ['front-end', 'backend', 'carregamento'],
    items: ['frontend/document', 'backend/auth', 'backend/postgrest', 'experience/public.load'], durationMinutes: 300,
  },
];

await fs.mkdir(OUT, { recursive: true });
await fs.writeFile(path.join(OUT, 'status.json'), JSON.stringify(status, null, 2) + '\n');
await fs.writeFile(path.join(OUT, 'history.jsonl'), history.map((h) => JSON.stringify(h)).join('\n') + '\n');
await fs.writeFile(path.join(OUT, 'incidents.json'), JSON.stringify(incidents, null, 2) + '\n');
console.log(`dados de demonstração escritos em ${path.relative(ROOT, OUT)}/`);
