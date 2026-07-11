// Headless engine run:
//   node tools/run_engine_node.mjs <in.pdf> <out.pdf> [scale] ["NAME=paletteIdx;NAME2=paletteIdx"]
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const PDFLib = require(path.join(root, 'node_modules/pdf-lib/dist/pdf-lib.js'));
const pdfjsLib = require(path.join(root, 'node_modules/pdfjs-dist/legacy/build/pdf.js'));
const createSidesEngine = require(path.join(root, 'engine.js'));

const [inFile, outFile, scaleArg, hlArg] = process.argv.slice(2);
const scale = parseFloat(scaleArg || '1.25');
const highlights = {};
if (hlArg) {
  for (const part of hlArg.split(';')) {
    const m = part.match(/^(.+)=(\d+)$/);
    if (m) highlights[m[1].trim()] = parseInt(m[2], 10);
  }
}

const engine = createSidesEngine({ pdfjsLib, PDFLib });
const bytes = new Uint8Array(fs.readFileSync(inFile));

try {
  const { bytes: out, report } = await engine.process(bytes, { scale, highlights });
  fs.writeFileSync(outFile, out);
  fs.writeFileSync(outFile + '.report.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (e) {
  if (e.code === 'SCANNED') { console.error('SCANNED: ' + e.message); process.exit(3); }
  throw e;
}
