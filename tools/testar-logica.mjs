#!/usr/bin/env node
// Testa a LÓGICA DE DECISÃO das sondas contra um alvo simulado.
//
// Não substitui a verificação real — prova que, dado um comportamento do
// servidor, o monitor chega ao veredito certo. Cada caso aqui corresponde a
// um defeito real encontrado em revisão.
//
//   node tools/testar-logica.mjs
import assert from 'node:assert/strict';
import { startMock } from './mock-alvo.mjs';

const cases = [];
let failures = 0;

function test(name, scenario, assertions, opts = {}) {
  cases.push({ name, scenario, assertions, noAuth: !!opts.noAuth });
}

/* ------------------------------------------------------------------ casos */

test(
  'cenário saudável: funções críticas publicadas e banco devolvendo linhas',
  {},
  ({ edge, db }) => {
    assert.equal(edge.status, 'ok', 'a seção de edge functions deveria estar ok');
    assert.equal(db.status, 'ok', 'as consultas ao banco deveriam estar ok');
  },
);

test(
  'FN-1: gateway devolve 401 para tudo — NUNCA pode virar verde',
  { gatewayAlways401: true },
  ({ edge }) => {
    assert.notEqual(edge.status, 'ok', 'um gateway que recusa tudo não pode produzir status ok');
    const funcs = edge.items.filter((i) => i.key !== '__canary__');
    for (const f of funcs) {
      assert.notEqual(f.status, 'ok', `${f.key} não pode estar "ok" quando o gateway recusou antes de rotear`);
    }
  },
);

test(
  'canário quebrado: se um slug inexistente não devolve 404, a sonda se declara não confiável',
  { canaryBroken: true },
  ({ edge }) => {
    assert.equal(edge.status, 'unknown', 'a seção deveria ser "unknown"');
    assert.match(edge.detail, /não confiável/i, 'o detalhe deveria dizer que a sonda não é confiável');
    assert.equal(edge.items.length, 1, 'não deveria julgar nenhuma função com a sonda quebrada');
  },
);

test(
  'função crítica removida do deploy é detectada',
  { missingFunctions: ['whatsapp-gateway'] },
  ({ edge }) => {
    assert.equal(edge.status, 'fail');
    const fn = edge.items.find((i) => i.key === 'whatsapp-gateway');
    assert.equal(fn.status, 'fail');
    assert.match(fn.detail, /NÃO ENCONTRADA/);
  },
);

test(
  'função NÃO crítica removida não derruba a seção',
  { missingFunctions: ['ai-engine'] },
  ({ edge }) => {
    assert.equal(edge.status, 'ok', 'função não crítica não pode tingir a seção');
    assert.equal(edge.items.find((i) => i.key === 'ai-engine').status, 'fail');
    assert.match(edge.detail, /não crítica/);
  },
);

test(
  'FN-4: RLS quebrada (HTTP 200 com zero linhas) é detectada como falha',
  { rlsEmpty: ['profiles'] },
  ({ db }) => {
    assert.equal(db.status, 'fail', 'zero linhas em tabela com expectRows tem que falhar');
    const probe = db.meta.probes.find((p) => p.table === 'profiles');
    assert.match(probe.detail, /ZERO linhas/);
  },
);

test(
  'tabela sem expectRows pode legitimamente vir vazia',
  { rlsEmpty: ['consultation_types'] },
  ({ db }) => {
    assert.equal(db.status, 'ok', 'tabela sem expectRows vazia não é falha');
  },
);

test(
  'HTML servido sem nenhum bundle do build é tratado como deploy quebrado',
  { htmlWithoutBundles: true },
  ({ frontend }) => {
    const doc = frontend.items.find((i) => i.key === 'document');
    assert.equal(doc.status, 'fail');
    assert.match(doc.detail, /bundle/i);
  },
);

test(
  'Supabase fora do ar: causa raiz nomeada e cascata suprimida',
  { supabaseDown: true },
  ({ backend, edge }) => {
    assert.equal(backend.status, 'fail');
    // A supressão de cascata roda no run.mjs; aqui garantimos que o núcleo
    // realmente falha, que é a condição que a dispara.
    const core = ['auth', 'postgrest', 'system-health'];
    for (const k of core) {
      assert.equal(backend.items.find((i) => i.key === k).status, 'fail', `${k} deveria falhar`);
    }
    assert.ok(edge, 'a seção de edge deve existir mesmo assim');
  },
);

test(
  'sem credenciais, as sondas autenticadas ficam "skipped" — e skipped não vale como ok',
  {},
  ({ db, worstStatus }) => {
    assert.equal(db.status, 'skipped');
    assert.notEqual(worstStatus(['ok', 'skipped']), 'ok', 'skipped não pode ser absorvido por ok');
  },
  { noAuth: true },
);

/* ------------------------------------------------------------- execução */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { worstStatus } from '../probe/config.mjs';

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));

for (const c of cases) {
  const mock = await startMock(c.scenario);
  try {
    const { stdout } = await execFileAsync(process.execPath, [path.join(HERE, '_executar-caso.mjs')], {
      env: {
        ...process.env,
        PD_APP_URL: mock.baseUrl,
        PD_SUPABASE_URL: mock.baseUrl,
        PD_SUPABASE_ANON_KEY: 'anon-mock',
        PD_APP_ALT_URLS: '',
        PD_CONTROL_TARGETS: `${mock.baseUrl}/__control__`,
        PD_MONITOR_EMAIL: c.noAuth ? '' : 'monitor@example.com',
        PD_MONITOR_PASSWORD: c.noAuth ? '' : 'senha-mock',
      },
      maxBuffer: 20 * 1024 * 1024,
      timeout: 90_000,
    });
    const marker = stdout.indexOf('__RESULT__');
    if (marker === -1) throw new Error('a sonda não devolveu resultado');
    const r = JSON.parse(stdout.slice(marker + '__RESULT__'.length));
    c.assertions({ ...r, worstStatus });
    console.log(`  \x1b[32m✔\x1b[0m ${c.name}`);
  } catch (err) {
    failures++;
    console.log(`  \x1b[31m✖\x1b[0m ${c.name}`);
    console.log(`      ${String(err.message).split('\n').slice(0, 4).join('\n      ')}`);
  } finally {
    await mock.close();
  }
}

console.log(`\n${cases.length - failures}/${cases.length} casos passaram.`);
process.exit(failures ? 1 : 0);
