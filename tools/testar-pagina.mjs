#!/usr/bin/env node
// Renderiza a página num DOM real (jsdom) com dados sintéticos e verifica que
// ela funciona. Não substitui olhar a página, mas pega o que quebra de fato:
// erro de execução no render, campo ausente virando "NaN"/"undefined" na tela,
// e vazamento de HTML pelos dados.
//
//   npm install --no-save jsdom && node tools/testar-pagina.mjs
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let JSDOM;
try {
  ({ JSDOM } = await import('jsdom'));
} catch {
  console.error('jsdom não está instalado. Rode:  npm install --no-save jsdom');
  process.exit(2);
}

const read = (p) => fs.readFile(path.join(ROOT, p), 'utf8');
const [html, appJs, statusJson, historyJsonl, incidentsJson] = await Promise.all([
  read('site/index.html'),
  read('site/app.js'),
  read('data/status.json'),
  read('data/history.jsonl'),
  read('data/incidents.json'),
]);

const arquivos = {
  './data/status.json': statusJson,
  './data/history.jsonl': historyJsonl,
  './data/incidents.json': incidentsJson,
};

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`  \x1b[32m✔\x1b[0m ${name}`); }
  catch (e) { failures++; console.log(`  \x1b[31m✖\x1b[0m ${name}\n      ${String(e.message).split('\n')[0]}`); }
};

async function renderizar(overrides = {}) {
  const dados = { ...arquivos, ...overrides };
  const dom = new JSDOM(html.replace('<script src="./app.js"></script>', ''), {
    runScripts: 'outside-only',
    url: 'https://status.example.com/',
    pretendToBeVisual: true,
  });
  const erros = [];
  dom.virtualConsole?.on?.('jsdomError', (e) => erros.push(e.message));

  dom.window.fetch = async (u) => {
    const key = String(u).split('?')[0];
    if (!(key in dados)) return { ok: false, status: 404, text: async () => '', json: async () => ({}) };
    const body = dados[key];
    return { ok: true, status: 200, text: async () => body, json: async () => JSON.parse(body) };
  };

  try {
    dom.window.eval(appJs);
  } catch (e) {
    erros.push(`erro ao executar app.js: ${e.message}`);
  }
  // Deixa as promessas do boot() resolverem.
  await new Promise((r) => setTimeout(r, 250));
  return { dom, doc: dom.window.document, erros, texto: dom.window.document.body.textContent || '' };
}

console.log('\nRender com dados completos');
{
  const { doc, erros, texto } = await renderizar();
  check('não houve erro de execução', () => assert.deepEqual(erros, []));
  check('o banner principal foi renderizado', () => assert.ok(doc.querySelector('.banner'), 'sem .banner'));
  check('os 4 cartões de área apareceram', () => assert.equal(doc.querySelectorAll('.card').length, 4));
  check('as seções detalhadas apareceram', () => assert.ok(doc.querySelectorAll('details.section').length >= 5));
  check('os gráficos de latência foram desenhados', () => {
    const svgs = [...doc.querySelectorAll('svg[data-chart]')];
    assert.equal(svgs.length, 4);
    assert.ok(svgs.every((s) => s.querySelector('polyline')), 'algum gráfico ficou sem linha');
  });
  check('as barras de histórico foram desenhadas', () => assert.ok(doc.querySelectorAll('.bars i').length > 50));
  check('a caixa do build aparece (primeira pergunta num incidente)', () => assert.ok(doc.querySelector('.deploy')));
  check('o runbook aparece', () => assert.ok(texto.includes('Para onde ir quando algo está vermelho')));
  check('nenhum "undefined" vazou para a tela', () => assert.doesNotMatch(texto, /undefined/));
  check('nenhum "NaN" vazou para a tela', () => assert.doesNotMatch(texto, /NaN/));
  check('nenhum "[object Object]" vazou para a tela', () => assert.doesNotMatch(texto, /\[object Object\]/));
  check('horários aparecem também em UTC', () => assert.match(texto, /UTC/));
  check('a seção informativa está marcada como tal', () => assert.ok(texto.includes('informativo')));
}

console.log('\nRender sem histórico (primeira execução do monitor)');
{
  const { doc, erros, texto } = await renderizar({ './data/history.jsonl': '' });
  check('não quebra sem histórico', () => assert.deepEqual(erros, []));
  check('ainda mostra o banner', () => assert.ok(doc.querySelector('.banner')));
  check('gráficos avisam que falta histórico', () => assert.match(texto, /sem histórico suficiente/));
}

console.log('\nRender com relatório de formato futuro');
{
  const futuro = JSON.stringify({ ...JSON.parse(statusJson), schemaVersion: 99 });
  const { texto, erros } = await renderizar({ './data/status.json': futuro });
  check('não quebra com schema desconhecido', () => assert.deepEqual(erros, []));
  check('avisa que a página está desatualizada', () => assert.match(texto, /desatualizada/i));
}

console.log('\nSegurança do render');
{
  const malicioso = JSON.parse(statusJson);
  malicioso.overall.summary = '<img src=x onerror="globalThis.__XSS__=1">';
  malicioso.sections[0].items[0].detail = '</div><script>globalThis.__XSS2__=1<\/script>';
  malicioso.target.url = 'javascript:globalThis.__XSS3__=1';
  const { dom, doc, texto } = await renderizar({ './data/status.json': JSON.stringify(malicioso) });
  check('conteúdo do relatório não vira HTML executável', () => {
    assert.equal(doc.querySelectorAll('#content img').length, 0, 'uma <img> foi injetada');
    assert.equal(doc.querySelectorAll('#content script').length, 0, 'um <script> foi injetado');
    assert.equal(dom.window.__XSS__, undefined);
    assert.equal(dom.window.__XSS2__, undefined);
  });
  check('o texto malicioso aparece escapado, como texto', () => assert.ok(texto.includes('<img src=x')));
  check('URL com esquema javascript: é rejeitada', () => {
    const hrefs = [...doc.querySelectorAll('a')].map((a) => a.getAttribute('href') || '');
    assert.ok(!hrefs.some((h) => h.toLowerCase().startsWith('javascript:')), 'um link javascript: passou');
  });
}

console.log(`\n${failures ? `\x1b[31m${failures} verificação(ões) falharam\x1b[0m` : '\x1b[32mTodas as verificações passaram\x1b[0m'}`);
process.exit(failures ? 1 : 0);
