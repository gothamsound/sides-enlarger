// Bundle everything into one self-contained sidesenlarger.html
// usage: node build.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.dirname(fileURLToPath(import.meta.url));
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

// inline scripts must not contain a literal "</script"; inside JS string
// literals "<\/script" is byte-identical after parsing, so this is safe.
const safe = s => s.replace(/<\/script/gi, '<\\/script');

const workerB64 = fs.readFileSync(path.join(root, 'node_modules/pdfjs-dist/legacy/build/pdf.worker.min.js')).toString('base64');

const template = read('ui_template.html');
const out = template
  .replace('/*__PDFJS__*/', () => safe(read('node_modules/pdfjs-dist/legacy/build/pdf.min.js')))
  .replace('/*__PDFWORKER_B64__*/', () => workerB64)
  .replace('/*__PDFLIB__*/', () => safe(read('node_modules/pdf-lib/dist/pdf-lib.min.js')))
  .replace('/*__ENGINE__*/', () => safe(read('engine.js')));

// index.html is the canonical, committed build output: GitHub Pages serves it
// directly, and it's also the single file to email/AirDrop to an actor.
const dest = path.join(root, 'index.html');
fs.writeFileSync(dest, out);
console.log('wrote', dest, (out.length / 1048576).toFixed(2) + ' MB');
