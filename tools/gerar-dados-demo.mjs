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

for (let i = HOURS - 1; i >= 0; i--) {
  const t = new Date(now - i * 3600_000).toISOString();
  // Duas janelas de incidente para exercitar as cores e a lista.
  const inOutage = i > 96 && i < 101;
  const inSlow = i > 40 && i < 46;
  const f = inOutage ? 'fail' : 'ok';
  const b = inOutage ? 'fail' : inSlow ? 'degraded' : 'ok';
  const e = inOutage ? 'degraded' : 'ok';
  const x = inOutage ? 'fail' : inSlow ? 'degraded' : 'ok';
  const s = [f, b, e, x].includes('fail') ? 'fail' : [f, b, e, x].includes('degraded') ? 'degraded' : 'ok';
  const jitter = (base, amp) => Math.round(base + Math.sin(i / 3.7) * amp + Math.random() * amp);
  history.push({
    t, s, f, b, e, x,
    lat: {
      doc: inOutage ? null : jitter(220, 70),
      db: inOutage ? null : inSlow ? jitter(1400, 300) : jitter(310, 90),
      edge: inOutage ? null : jitter(480, 140),
      load: inOutage ? null : inSlow ? jitter(7200, 900) : jitter(2600, 500),
      lcp: inOutage ? null : jitter(1700, 400),
      login: inOutage ? null : jitter(3400, 700),
    },
  });
}

const status = {
  schemaVersion: 2,
  generatedAt: new Date(now).toISOString(),
  durationMs: 41230,
  target: { name: 'PrimeDoctor', url: 'https://primedoctor.app', supabaseRef: 'iewdxiggqwyjdqbtmojm' },
  authenticated: true,
  overall: { status: 'ok', label: 'Todos os sistemas operacionais', summary: 'Todos os sistemas operando normalmente.' },
  sections: [
    {
      key: 'frontend', label: 'Hospedagem e front-end', status: 'ok', latencyMs: 214,
      detail: '6 verificação(ões) OK',
      items: [
        { key: 'dns', label: 'Resolução DNS', status: 'ok', latencyMs: 28, detail: '2 endereço(s)' },
        { key: 'tls', label: 'Certificado TLS', status: 'ok', latencyMs: 96, detail: 'expira em 64 dia(s) · Google Trust Services' },
        { key: 'document', label: 'Documento HTML', status: 'ok', latencyMs: 214, detail: 'HTTP 200 · 2.3 kB · Cloudflare' },
        { key: 'bundles', label: 'Bundles do build (JS/CSS)', status: 'ok', latencyMs: 331, detail: '4 bundle(s) OK' },
        { key: 'static', label: 'Arquivos estáticos (manifest, favicon, robots)', status: 'ok', latencyMs: 118, detail: '3 arquivo(s) OK' },
        { key: 'spa-fallback', label: 'Roteamento SPA (deep link)', status: 'ok', latencyMs: 190, detail: 'rotas internas devolvem o app corretamente' },
      ],
    },
    {
      key: 'backend', label: 'Banco de dados e backend', status: 'degraded', latencyMs: 402,
      detail: 'Consultas ao banco de dados',
      items: [
        { key: 'auth', label: 'Serviço de autenticação', status: 'ok', latencyMs: 141, detail: 'no ar · v2.180.0' },
        { key: 'postgrest', label: 'API do banco (PostgREST)', status: 'ok', latencyMs: 178, detail: 'no ar' },
        { key: 'system-health', label: 'Healthcheck do PrimeDoctor (banco)', status: 'ok', latencyMs: 402, detail: 'banco respondendo em 84ms' },
        {
          key: 'database', label: 'Consultas ao banco de dados', status: 'degraded', latencyMs: 268,
          detail: '1 com problema: crm_leads',
          meta: { probes: [
            { table: 'clinics', status: 'ok', ms: 191 },
            { table: 'profiles', status: 'ok', ms: 233 },
            { table: 'clinic_members', status: 'ok', ms: 268 },
            { table: 'contacts', status: 'ok', ms: 301 },
            { table: 'chat_messages', status: 'ok', ms: 344 },
            { table: 'crm_leads', status: 'degraded', ms: 902 },
          ] },
        },
        { key: 'realtime', label: 'Realtime (tempo real)', status: 'ok', latencyMs: 388, detail: 'websocket conectado' },
        { key: 'storage', label: 'Armazenamento de arquivos', status: 'ok', latencyMs: 205, detail: 'serviço respondendo e acessível' },
      ],
    },
    {
      key: 'edge', label: 'Funções de borda (integrações)', status: 'ok', latencyMs: 452,
      detail: '14 funções publicadas',
      items: [
        { key: 'system-health', label: 'Healthcheck do backend', critical: true, status: 'ok', latencyMs: 233, detail: 'publicada · HTTP 200' },
        { key: 'whatsapp-gateway', label: 'Gateway WhatsApp', critical: true, status: 'ok', latencyMs: 410, detail: 'publicada · HTTP 200' },
        { key: 'zapi-webhook', label: 'Webhook Z-API', critical: true, status: 'ok', latencyMs: 388, detail: 'publicada · HTTP 200' },
        { key: 'ai-engine', label: 'Motor de IA', critical: false, status: 'ok', latencyMs: 640, detail: 'publicada · HTTP 200' },
      ],
    },
    {
      key: 'experience', label: 'Experiência de carregamento', status: 'ok', latencyMs: 2480,
      detail: '9 verificação(ões) OK',
      items: [
        { key: 'public.load', label: 'Tela de acesso (pública) — tempo de carregamento', status: 'ok', latencyMs: 2480, detail: 'app pronto em 2.48s · TTFB 186ms' },
        { key: 'public.lcp', label: 'Tela de acesso (pública) — primeira tela visível', status: 'ok', latencyMs: 1640, detail: 'maior elemento pintado em 1.64s · primeiro conteúdo em 900ms' },
        { key: 'public.components', label: 'Tela de acesso (pública) — componentes montados', status: 'ok', latencyMs: null, detail: 'formulário de acesso renderizado' },
        { key: 'public.errors', label: 'Tela de acesso (pública) — erros de JavaScript', status: 'ok', latencyMs: null, detail: 'nenhum erro no console' },
        { key: 'public.resources', label: 'Tela de acesso (pública) — recursos carregados', status: 'ok', latencyMs: null, detail: '11 script(s) carregados, nenhuma requisição falhou' },
        { key: 'authed.load', label: 'Área autenticada — tempo de carregamento', status: 'ok', latencyMs: 2610, detail: 'app pronto em 2.61s · TTFB 172ms' },
        { key: 'authed.components', label: 'Área autenticada — componentes montados', status: 'ok', latencyMs: 3380, detail: 'login e carregamento da área interna em 3.4s' },
        {
          key: 'authed.errors', label: 'Área autenticada — erros de JavaScript', status: 'degraded', latencyMs: null,
          detail: '1 erro(s) no console',
          meta: { samples: ['Failed to load resource: the server responded with a status of 404'] },
        },
        { key: 'authed.resources', label: 'Área autenticada — recursos carregados', status: 'ok', latencyMs: null, detail: '23 script(s) carregados, nenhuma requisição falhou' },
      ],
    },
    {
      key: 'upstream', label: 'Plataformas de terceiros', informational: true, status: 'ok', latencyMs: null,
      detail: 'nenhum incidente relatado',
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
  { startedAt: new Date(now - 45 * 3600_000).toISOString(), endedAt: new Date(now - 40 * 3600_000).toISOString(), worst: 'degraded', checks: 5, areas: ['backend', 'carregamento'], durationMinutes: 300 },
  { startedAt: new Date(now - 101 * 3600_000).toISOString(), endedAt: new Date(now - 96 * 3600_000).toISOString(), worst: 'fail', checks: 4, areas: ['front-end', 'backend', 'integrações', 'carregamento'], durationMinutes: 300 },
];

await fs.mkdir(OUT, { recursive: true });
await fs.writeFile(path.join(OUT, 'status.json'), JSON.stringify(status, null, 2) + '\n');
await fs.writeFile(path.join(OUT, 'history.json'), JSON.stringify(history) + '\n');
await fs.writeFile(path.join(OUT, 'incidents.json'), JSON.stringify(incidents, null, 2) + '\n');
console.log(`dados de demonstração escritos em ${path.relative(ROOT, OUT)}/`);
