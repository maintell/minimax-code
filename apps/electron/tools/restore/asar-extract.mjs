// Extract files from an Electron ASAR archive.
// Usage:
//   node asar-extract.mjs <asarPath> <outDir> [--all | <prefix> ...]
// A prefix matches files whose archive path equals the prefix or starts with "<prefix>/".
import fs from 'node:fs';
import path from 'node:path';

const asarPath = process.argv[2];
const outDir = process.argv[3];
const args = process.argv.slice(4);
if (!asarPath || !outDir) {
  console.error('usage: node asar-extract.mjs <asarPath> <outDir> [--all | <prefix> ...]');
  process.exit(1);
}
const all = args.includes('--all');
const prefixes = args.filter((a) => a !== '--all');
if (!all && prefixes.length === 0) {
  console.error('specify --all or at least one prefix');
  process.exit(1);
}

const fd = fs.openSync(asarPath, 'r');
const sizeBuf = Buffer.alloc(8);
fs.readSync(fd, sizeBuf, 0, 8, 0);
const size = sizeBuf.readUInt32LE(4);
const headerBuf = Buffer.alloc(size);
fs.readSync(fd, headerBuf, 0, size, 8);
const strLen = headerBuf.readUInt32LE(4);
const header = JSON.parse(headerBuf.toString('utf8', 8, 8 + strLen));

const rows = [];
function walk(node, prefix) {
  if (node.files) {
    for (const [name, child] of Object.entries(node.files)) walk(child, prefix ? `${prefix}/${name}` : name);
    return;
  }
  rows.push({ p: prefix, size: node.size ?? 0, offset: Number(node.offset ?? 0), unpacked: !!node.unpacked, link: node.link });
}
walk(header, '');

const unpackedDir = `${asarPath}.unpacked`;

// Verify data base offset using a small known-json file.
function dataBaseFor(row) {
  return 8 + size + row.offset; // candidate; verified below
}
function readRow(row) {
  const buf = Buffer.alloc(row.size);
  if (row.size > 0) fs.readSync(fd, buf, 0, row.size, dataBaseFor(row));
  return buf;
}
const pkg = rows.find((r) => r.p === 'package.json');
if (pkg) {
  const text = readRow(pkg).toString('utf8').trim();
  if (!text.startsWith('{')) {
    // try alternative bases
    for (const base of [4 + size, 8 + size + ((4 - (strLen % 4)) % 4 ? 4 : 0)]) {
      const buf = Buffer.alloc(pkg.size);
      fs.readSync(fd, buf, 0, pkg.size, base + pkg.offset);
      if (buf.toString('utf8').trim().startsWith('{')) {
        console.error(`NOTE: using alternative data base ${base}`);
        dataBaseForOverride = base;
        break;
      }
    }
  }
}
let dataBaseForOverride = null;

let extracted = 0;
let bytes = 0;
for (const row of rows) {
  if (!all && !prefixes.some((p) => row.p === p || row.p.startsWith(`${p}/`))) continue;
  const dest = path.join(outDir, row.p);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (row.link) {
    console.error(`skip symlink: ${row.p}`);
    continue;
  }
  if (row.unpacked) {
    const src = path.join(unpackedDir, row.p);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dest);
      extracted++;
      bytes += row.size;
    } else {
      console.error(`missing unpacked file: ${src}`);
    }
    continue;
  }
  const buf = Buffer.alloc(row.size);
  const base = dataBaseForOverride ?? 8 + size;
  if (row.size > 0) fs.readSync(fd, buf, 0, row.size, base + row.offset);
  fs.writeFileSync(dest, buf);
  extracted++;
  bytes += row.size;
}
console.log(`extracted ${extracted} files, ${(bytes / 1024 / 1024).toFixed(1)}MB to ${outDir}`);
fs.closeSync(fd);
