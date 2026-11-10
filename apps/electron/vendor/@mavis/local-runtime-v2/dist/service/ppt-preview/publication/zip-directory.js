import { inflateRawSync } from 'node:zlib';
function directory(bytes) {
    let end = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
        if (bytes.readUInt32LE(i) !== 0x06054b50)
            continue;
        if (i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) {
            end = i;
            break;
        }
    }
    if (end < 0)
        throw new Error('Missing ZIP directory');
    const start = bytes.readUInt32LE(end + 16);
    const count = bytes.readUInt16LE(end + 10);
    const invalid = [
        bytes.readUInt16LE(end + 4) !== 0,
        bytes.readUInt16LE(end + 6) !== 0,
        count > 10000,
        count !== bytes.readUInt16LE(end + 8),
        start + bytes.readUInt32LE(end + 12) !== end,
    ];
    if (invalid.some(Boolean))
        throw new Error('Invalid ZIP directory');
    return { end, start, count };
}
function entry(bytes, offset, end) {
    if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50)
        throw new Error('Invalid ZIP entry');
    const nameLength = bytes.readUInt16LE(offset + 28);
    const next = offset + 46 + nameLength + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
    if (next > end)
        throw new Error('Truncated ZIP entry');
    if ((bytes.readUInt16LE(offset + 8) & 1) !== 0)
        throw new Error('Encrypted ZIP entry');
    return {
        name: bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8'),
        compressed: bytes.readUInt32LE(offset + 20),
        expanded: bytes.readUInt32LE(offset + 24),
        method: bytes.readUInt16LE(offset + 10),
        local: bytes.readUInt32LE(offset + 42),
        next,
    };
}
function checkName(name, names) {
    if (names.has(name) ||
        name.includes('\\') ||
        name.startsWith('/') ||
        name.split('/').includes('..'))
        throw new Error('Ambiguous ZIP path');
    names.add(name);
}
function checkBudget(part, expanded) {
    if (part.expanded > 64 * 1024 * 1024 || expanded > 256 * 1024 * 1024)
        throw new Error('ZIP expansion exceeds limits');
    if (part.expanded > 1024 * 1024 && part.expanded > Math.max(1, part.compressed) * 200)
        throw new Error('ZIP compression ratio exceeds limits');
}
function presentation(bytes, part, start) {
    if (part.local + 30 > start || bytes.readUInt32LE(part.local) !== 0x04034b50)
        throw new Error('Invalid presentation part');
    if ((bytes.readUInt16LE(part.local + 6) & 1) !== 0 || part.expanded > 1024 * 1024)
        throw new Error('Unsupported presentation part');
    const dataStart = part.local + 30 + bytes.readUInt16LE(part.local + 26) + bytes.readUInt16LE(part.local + 28);
    if (dataStart + part.compressed > start)
        throw new Error('Truncated presentation part');
    const data = bytes.subarray(dataStart, dataStart + part.compressed);
    const result = inflatePresentation(data, part);
    if (result.length !== part.expanded)
        throw new Error('Presentation ZIP size mismatch');
    return result;
}
function inflatePresentation(data, part) {
    if (part.method === 0)
        return data;
    if (part.method === 8)
        return inflateRawSync(data, {
            maxOutputLength: Math.max(1, Math.min(part.expanded, 1024 * 1024)),
        });
    throw new Error('Unsupported ZIP compression');
}
/** Declared expansion budgets plus bounded actual inflation; Safe OPC still owns full package validation. */
export function readBoundedPresentation(bytes) {
    const dir = directory(bytes);
    const names = new Set();
    let offset = dir.start;
    let expanded = 0;
    let xml;
    for (let index = 0; index < dir.count; index++) {
        const part = entry(bytes, offset, dir.end);
        expanded += part.expanded;
        checkName(part.name, names);
        checkBudget(part, expanded);
        if (part.name === 'ppt/presentation.xml')
            xml = presentation(bytes, part, dir.start);
        offset = part.next;
    }
    if (offset !== dir.end)
        throw new Error('Invalid ZIP entry count');
    if (!xml || !names.has('[Content_Types].xml') || !names.has('ppt/_rels/presentation.xml.rels'))
        throw new Error('Presentation parts are missing');
    return xml;
}
//# sourceMappingURL=zip-directory.js.map