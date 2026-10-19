// Compare recompiled output against the shipped dist/main build.
// Usage: node verify-main.mjs <shipped-main-dir> <recompiled-main-dir> [--details=path]
import fs from 'node:fs';
import path from 'node:path';

const shippedDir = process.argv[2];
const outDir = process.argv[3];
const detailsArg = process.argv.find((a) => a.startsWith('--details='));
const detailsPath = detailsArg ? detailsArg.split('=')[1] : null;

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
  });
}

function normalize(text) {
  return text
    .replace(/^\/\/# sourceMappingURL=.*$/gm, '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/^\s*\n/, '')
    .replace(/\s+$/, '');
}

const shipped = walk(shippedDir).filter((f) => f.endsWith('.js'));
const rows = [];
let identical = 0;
let different = 0;
let missing = 0;
const details = [];

for (const file of shipped) {
  const rel = path.relative(shippedDir, file).replace(/\\/g, '/');
  const outFile = path.join(outDir, rel);
  if (!fs.existsSync(outFile)) {
    missing += 1;
    rows.push(`MISSING  ${rel}`);
    continue;
  }
  const a = normalize(fs.readFileSync(file, 'utf8'));
  const b = normalize(fs.readFileSync(outFile, 'utf8'));
  if (a === b) {
    identical += 1;
    continue;
  }
  different += 1;
  const aLines = a.split('\n');
  const bLines = b.split('\n');
  const max = Math.max(aLines.length, bLines.length);
  let first = -1;
  let diffLines = 0;
  for (let i = 0; i < max; i++) {
    if ((aLines[i] ?? '') !== (bLines[i] ?? '')) {
      diffLines += 1;
      if (first < 0) first = i;
    }
  }
  rows.push(`DIFF(${diffLines}/${max})  ${rel}  first@${first + 1}`);
  details.push({
    rel,
    diffLines,
    first,
    aLines,
    bLines,
  });
}

rows.sort();
console.log(`shipped files: ${shipped.length}`);
console.log(`identical: ${identical}`);
console.log(`different: ${different}`);
console.log(`missing output: ${missing}`);
if (details.length) {
  console.log('\n-- per-file diff summary --');
  for (const d of details.sort((x, y) => y.diffLines - x.diffLines)) {
    console.log(`  ${String(d.diffLines).padStart(5)} diffs  ${d.rel}`);
  }
}
if (detailsPath) {
  const text = details
    .map((d) => {
      const lines = [`===== ${d.rel} =====`];
      const max = Math.max(d.aLines.length, d.bLines.length);
      let shown = 0;
      for (let i = 0; i < max && shown < 60; i++) {
        const a = d.aLines[i] ?? '';
        const b = d.bLines[i] ?? '';
        if (a !== b) {
          lines.push(`  ${i + 1} SHIPPED: ${a}`);
          lines.push(`  ${i + 1} REBUILT: ${b}`);
          shown += 1;
        }
      }
      return lines.join('\n');
    })
    .join('\n\n');
  fs.writeFileSync(detailsPath, text, 'utf8');
  console.log(`\ndetails written to ${detailsPath}`);
}
