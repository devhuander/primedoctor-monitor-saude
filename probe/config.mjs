// Configuração central do monitor.
// Nada aqui é segredo: a anon key do Supabase é pública por design (protegida por RLS).
// Credenciais do usuário-monitor vêm de variáveis de ambiente (GitHub Secrets).

export const CONFIG = {
  app: {
    name: 'PrimeDoctor',
    baseUrl: process.env.PD_APP_URL || 'https://primedoctor.app',
    // Rota pública usada para medir carregamento sem exigir sessão.
    publicRoute: '/auth',
    // Rota inexistente: valida se o fallback de SPA está configurado no host.
    spaFallbackRoute: '/__monitor_spa_fallback_check__',
    // Assets estáticos que precisam existir no host.
    staticAssets: ['/manifest.json', '/favicon.ico', '/robots.txt'],
  },

  supabase: {
    url: process.env.PD_SUPABASE_URL || 'https://iewdxiggqwyjdqbtmojm.supabase.co',
    anonKey:
      process.env.PD_SUPABASE_ANON_KEY ||
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlld2R4aWdncXd5amRxYnRtb2ptIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjkxMjUxNDQsImV4cCI6MjA4NDcwMTE0NH0.p6bj0810m9NK9YJL6fs5QcbNKYBJ69xg7-tTsj1TJ9U',
  },

  // Credenciais do usuário dedicado de monitoramento (opcional).
  // Sem elas, as checagens autenticadas são puladas (status "skipped", não "fail").
  auth: {
    email: process.env.PD_MONITOR_EMAIL || '',
    password: process.env.PD_MONITOR_PASSWORD || '',
  },

  // Edge functions críticas. Checadas via OPTIONS (preflight CORS):
  // responde 2xx se está publicada, 404 se sumiu do deploy. OPTIONS não
  // executa a lógica da função, então é seguro rodar de hora em hora.
  edgeFunctions: [
    { name: 'system-health', label: 'Healthcheck do backend', critical: true },
    { name: 'whatsapp-gateway', label: 'Gateway WhatsApp', critical: true },
    { name: 'zapi-webhook', label: 'Webhook Z-API', critical: true },
    { name: 'meta-whatsapp-webhook', label: 'Webhook Meta WhatsApp', critical: true },
    { name: 'lead-capture-webhook', label: 'Captação de leads', critical: true },
    { name: 'send-whatsapp', label: 'Envio de WhatsApp', critical: true },
    { name: 'google-calendar', label: 'Google Agenda', critical: true },
    { name: 'ai-engine', label: 'Motor de IA', critical: false },
    { name: 'ai-attendant', label: 'Atendente IA', critical: false },
    { name: 'inngest', label: 'Fila de jobs (Inngest)', critical: false },
    { name: 'submit-form-response', label: 'Fichas de paciente', critical: false },
    { name: 'print-job-create', label: 'Impressão', critical: false },
    { name: 'embed-form-config', label: 'Formulários embed', critical: false },
    { name: 'mcp', label: 'MCP', critical: false },
  ],

  // Tabelas lidas para provar que o Postgres + PostgREST + RLS estão de pé.
  // Só gravamos latência e sucesso/erro — nunca o conteúdo das linhas.
  dbProbes: [
    { table: 'clinics', label: 'Clínicas', authOnly: false },
    { table: 'profiles', label: 'Perfis', authOnly: true },
    { table: 'clinic_members', label: 'Membros', authOnly: true },
    { table: 'contacts', label: 'Contatos', authOnly: true },
    { table: 'chat_messages', label: 'Mensagens', authOnly: true },
    { table: 'crm_leads', label: 'Leads CRM', authOnly: true },
  ],

  // Páginas de status de terceiros (statuspage.io). Informativo:
  // nunca derruba o status geral, só contextualiza uma queda.
  upstreams: [
    { key: 'supabase', label: 'Supabase', url: 'https://status.supabase.com/api/v2/status.json' },
    { key: 'lovable', label: 'Lovable', url: 'https://status.lovable.dev/api/v2/status.json' },
    { key: 'cloudflare', label: 'Cloudflare', url: 'https://www.cloudflarestatus.com/api/v2/status.json' },
    { key: 'github', label: 'GitHub', url: 'https://www.githubstatus.com/api/v2/status.json' },
  ],

  // Limiares (ms). Acima de `warn` => degradado; acima de `fail` => falha.
  thresholds: {
    httpWarn: 1500,
    httpFail: 5000,
    dbWarn: 800,
    dbFail: 3000,
    edgeWarn: 2000,
    edgeFail: 8000,
    pageLoadWarn: 5000,
    pageLoadFail: 12000,
    lcpWarn: 2500,
    lcpFail: 4000,
    tlsExpiryWarnDays: 21,
    tlsExpiryFailDays: 7,
  },

  timeouts: {
    http: 20000,
    browser: 60000,
    realtime: 12000,
  },

  history: {
    // Retenção do histórico detalhado (entradas horárias).
    maxEntries: 24 * 90, // ~90 dias
  },
};

export const STATUS = {
  OK: 'ok',
  DEGRADED: 'degraded',
  FAIL: 'fail',
  SKIPPED: 'skipped',
  UNKNOWN: 'unknown',
};

// Ordem de severidade para agregação.
const RANK = { ok: 0, skipped: 0, unknown: 1, degraded: 2, fail: 3 };

export function worstStatus(list) {
  let worst = STATUS.OK;
  for (const s of list) {
    if ((RANK[s] ?? 1) > (RANK[worst] ?? 0)) worst = s;
  }
  return worst;
}

export function statusFromLatency(ms, warn, fail) {
  if (ms >= fail) return STATUS.FAIL;
  if (ms >= warn) return STATUS.DEGRADED;
  return STATUS.OK;
}
