#!/usr/bin/env node
// Roda o probe COMPLETO contra o alvo simulado, várias vezes, e confere o
// comportamento que só aparece ao longo de várias execuções: confirmação em
// dois ciclos, supressão de cascata, histórico e agrupamento de incidentes.
//
//   node tools/testar-e2e.mjs
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { startMock } from './mock-alvo.mjs';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');

async function cycle(scenario) {
  const mock = await startMock(scenario);
  try {
    await run(process.execPath, [path.join(ROOT, 'probe/run.mjs'), '--no-browser'], {
      cwd: ROOT,
      env: {
        ...process.env,
        PD_APP_URL: mock.baseUrl,
        PD_SUPABASE_URL: mock.baseUrl,
        PD_SUPABASE_ANON_KEY: 'anon-mock',
        PD_APP_ALT_URLS: '',
        PD_CONTROL_TARGETS: `${mock.baseUrl}/__control__`,
        PD_MONITOR_EMAIL: 'monitor@example.com',
        PD_MONITOR_PASSWORD: 'senha-mock',
      },
      maxBuffer: 20 * 1024 * 1024,
      timeout: 120_000,
    });
  } finally {
    await mock.close();
  }
  return JSON.parse(await fs.readFile(path.join(DATA, 'status.json'), 'utf8'));
}

const readJson = async (f) => JSON.parse(await fs.readFile(path.join(DATA, f), 'utf8'));
const readLines = async (f) =>
  (await fs.readFile(path.join(DATA, f), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));

// Começa de um estado limpo para o histórico ser determinístico.
await fs.rm(DATA, { recursive: true, force: true });
await fs.mkdir(DATA, { recursive: true });

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  \x1b[32m✔\x1b[0m ${name}`); }
  catch (e) { failures++; console.log(`  \x1b[31m✖\x1b[0m ${name}\n      ${e.message.split('\n')[0]}`); }
};

console.log('\nCiclo 1 e 2 — sistema saudável');
await cycle({});
const sadio = await cycle({});
check('não declara falha com o sistema no ar', () => {
  assert.notEqual(sadio.overall.status, 'fail');
  assert.equal(sadio.overall.alarm, false);
});

console.log('\nCiclo 3 — Supabase cai (primeira execução ruim)');
const queda1 = await cycle({ supabaseDown: true });
check('detecta a falha imediatamente', () => assert.equal(queda1.overall.status, 'fail'));
check('NÃO alarma na primeira execução ruim', () => assert.equal(queda1.overall.alarm, false));
check('nomeia a causa raiz em vez de listar tudo', () => {
  assert.match(queda1.rootCause || '', /Supabase indisponível/i);
});
check('suprime a cascata: seções dependentes viram "não verificável"', () => {
  const edge = queda1.sections.find((s) => s.key === 'edge');
  assert.equal(edge.status, 'unknown');
  assert.match(edge.detail, /não verificável/i);
});

console.log('\nCiclo 4 — Supabase continua fora (segunda execução ruim)');
const queda2 = await cycle({ supabaseDown: true });
check('confirma e alarma na segunda execução ruim consecutiva', () => {
  assert.equal(queda2.overall.status, 'fail');
  assert.equal(queda2.overall.confirmed, true);
  assert.equal(queda2.overall.alarm, true);
});

console.log('\nCiclo 5 — sistema volta');
const volta = await cycle({});
check('para de alarmar quando volta', () => assert.equal(volta.overall.alarm, false));

console.log('\nHistórico e incidentes');
const history = await readLines('history.jsonl');
const incidents = await readJson('incidents.json');
check('histórico gravou uma linha por execução', () => assert.equal(history.length, 5));
check('histórico é append-only (JSONL)', () => assert.ok(history.every((h) => h.t && h.s)));
check('agrupou as duas execuções ruins num único incidente', () => {
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0].checks, 2);
  assert.equal(incidents[0].worst, 'fail');
});
check('o incidente foi encerrado quando o sistema voltou', () => assert.ok(incidents[0].endedAt));
check('o incidente registra QUAIS itens falharam (para post-mortem)', () => {
  assert.ok(incidents[0].items.length > 0, 'nenhum item registrado');
  assert.ok(incidents[0].items.some((k) => k.startsWith('backend/')));
});

console.log('\nPrivacidade do relatório publicado');
const publicado = JSON.stringify(await readJson('status.json'));
check('nenhum e-mail vaza no JSON publicado', () => assert.doesNotMatch(publicado, /monitor@example\.com/));
check('nenhuma senha vaza no JSON publicado', () => assert.doesNotMatch(publicado, /senha-mock/));

// Deixa o repositório limpo: dados de teste não podem virar commit.
await fs.rm(DATA, { recursive: true, force: true });
await fs.mkdir(DATA, { recursive: true });
await fs.writeFile(path.join(DATA, '.gitkeep'), '');

console.log(`\n${failures ? `\x1b[31m${failures} verificação(ões) falharam\x1b[0m` : '\x1b[32mTodas as verificações passaram\x1b[0m'}`);
process.exit(failures ? 1 : 0);
