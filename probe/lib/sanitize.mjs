import crypto from 'node:crypto';

/**
 * Este repositório é PÚBLICO e o histórico do git é permanente. Nada que saia
 * daqui pode ser desfeito depois. Por isso o tratamento de texto vindo do
 * sistema monitorado é por ALLOWLIST, não por blocklist:
 *
 *  - mensagens de erro do console NUNCA são publicadas em texto integral;
 *  - o que vai para o JSON é uma CATEGORIA reconhecida + um hash estável;
 *  - o hash permite dizer "é o mesmo erro de ontem" sem revelar o conteúdo.
 *
 * O app do PrimeDoctor loga telefone de paciente, busca por nome e erros do
 * Postgres com valores de linha embutidos ("Key (phone_number)=(+55…)").
 * Blocklist de e-mail/UUID/JWT não protege contra nada disso.
 */

/** Máscara para textos que precisam ser exibidos (detalhes operacionais nossos). */
export function scrub(text) {
  if (text == null) return text;
  return String(text)
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '«email»')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '«id»')
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, '«token»')
    .replace(/\d{3}\.?\d{3}\.?\d{3}-?\d{2}/g, '«cpf»')
    .replace(/\+?\d[\d\s().-]{8,}\d/g, '«telefone»')
    .replace(/\b[A-Za-z0-9_-]{24,}\b/g, '«opaco»')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

// Categorias reconhecidas de erro de front-end. A ordem importa: a primeira
// que casar vence. Qualquer coisa fora desta lista vira "outro".
const CATEGORIES = [
  [/ChunkLoadError|Loading chunk \d+ failed|Failed to fetch dynamically imported module/i, 'chunk-nao-carregou', 'Um pedaço do app (chunk JS) não carregou — típico de deploy novo com cache velho'],
  [/Loading CSS chunk/i, 'css-nao-carregou', 'Um arquivo de estilo não carregou'],
  [/NetworkError|Failed to fetch|net::ERR|ERR_NETWORK|ERR_INTERNET/i, 'rede', 'Falha de rede numa requisição do app'],
  [/\b(401|403)\b|Unauthorized|Forbidden|JWT|invalid.token|not authenticated/i, 'autorizacao', 'Requisição recusada por autenticação/autorização'],
  [/\b5\d{2}\b|Internal Server Error|Bad Gateway|Service Unavailable/i, 'erro-servidor', 'O servidor devolveu erro 5xx'],
  [/\b404\b|Not Found/i, 'recurso-404', 'Um recurso pedido pelo app não existe'],
  [/ResizeObserver loop/i, 'resize-observer', 'Aviso benigno de layout do navegador'],
  [/Content Security Policy|Refused to (load|connect|execute)/i, 'csp', 'Bloqueio de Content Security Policy'],
  [/Hydration|Minified React error|Cannot update a component/i, 'react', 'Erro interno de renderização do React'],
  [/is not a function|undefined is not|Cannot read propert|null is not an object|TypeError/i, 'tipo-indefinido', 'TypeError no código do app — normalmente bug de regressão'],
  [/QuotaExceeded|localStorage|IndexedDB/i, 'armazenamento', 'Problema com armazenamento local do navegador'],
  [/timeout|timed out|AbortError/i, 'timeout', 'Alguma operação estourou o tempo limite'],
];

/**
 * Classifica um erro sem publicar o texto original.
 * Devolve { categoria, descricao, hash } — nada reversível.
 */
export function classifyError(text) {
  const raw = String(text ?? '');
  for (const [re, key, description] of CATEGORIES) {
    if (re.test(raw)) return { category: key, description, hash: shortHash(raw) };
  }
  return {
    category: 'outro',
    description: 'Erro não classificado — veja os logs da execução para o texto completo',
    hash: shortHash(raw),
  };
}

/** Agrupa uma lista de erros em categorias com contagem. */
export function summarizeErrors(list) {
  const byCategory = new Map();
  for (const text of list) {
    const c = classifyError(text);
    const entry = byCategory.get(c.category) || { ...c, count: 0, hashes: new Set() };
    entry.count += 1;
    entry.hashes.add(c.hash);
    byCategory.set(c.category, entry);
  }
  return [...byCategory.values()]
    .map((e) => ({ category: e.category, description: e.description, count: e.count, distinct: e.hashes.size }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Reduz uma URL ao que é seguro publicar: origem + um path genérico.
 * Segmentos que parecem id, hash ou nome de arquivo viram placeholder — é onde
 * moram UUID de paciente e nome de anexo em Storage.
 */
export function safeUrl(input) {
  let parsed;
  try {
    parsed = new URL(String(input));
  } catch {
    return '«url inválida»';
  }
  if (!/^https?:$/.test(parsed.protocol)) return '«esquema não-http»';
  const segments = parsed.pathname.split('/').filter(Boolean).map((seg) => {
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(seg)) return ':id';
    if (/^\d+$/.test(seg)) return ':n';
    if (seg.length > 24) return ':opaco';
    if (/\.[a-z0-9]{2,5}$/i.test(seg) && !/^index|^main|^assets?$/i.test(seg)) {
      // Mantém a extensão (diz o tipo do recurso), esconde o nome.
      return ':arquivo' + seg.slice(seg.lastIndexOf('.'));
    }
    return seg;
  });
  return `${parsed.origin}/${segments.join('/')}`;
}

function shortHash(text) {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 8);
}
