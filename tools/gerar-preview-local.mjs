// Gera um único arquivo HTML autocontido (CSS + JS + dados embutidos) para
// abrir direto no navegador com file://, sem servidor e sem esbarrar em CORS.
//   node tools/gerar-preview-local.mjs  →  preview-local.html
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFile(path.join(ROOT, p), 'utf8');

const [html, css, js, status, history, incidents] = await Promise.all([
  read('site/index.html'),
  read('site/styles.css'),
  read('site/app.js'),
  read('data/status.json'),
  read('data/history.json').catch(() => '[]'),
  read('data/incidents.json').catch(() => '[]'),
]);

// Substitui o fetch por dados embutidos.
const shim = `
window.__PD_EMBEDDED__ = {
  './data/status.json': ${status},
  './data/history.json': ${history},
  './data/incidents.json': ${incidents}
};
`;

const patchedJs = js.replace(
  /async function loadJson\(url\) \{[\s\S]*?\n\}/,
  `async function loadJson(url) {
  const data = window.__PD_EMBEDDED__?.[url];
  if (data === undefined) throw new Error('sem dados embutidos para ' + url);
  return JSON.parse(JSON.stringify(data));
}`,
);

const out = html
  .replace('<link rel="stylesheet" href="./styles.css" />', `<style>\n${css}\n</style>`)
  .replace('<script src="./app.js"></script>', `<script>${shim}\n${patchedJs}</script>`)
  .replace('</title>', ' (preview local)</title>');

await fs.writeFile(path.join(ROOT, 'preview-local.html'), out);
console.log('preview-local.html gerado — abra no navegador com file://');
