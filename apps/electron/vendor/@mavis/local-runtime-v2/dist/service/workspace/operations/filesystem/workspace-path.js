import { mkdir, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { TextDecoder } from 'node:util';
const TEXT_EXTENSIONS = new Set([
    '.asm',
    '.bash',
    '.c',
    '.cc',
    '.cjs',
    '.cmake',
    '.conf',
    '.cpp',
    '.cs',
    '.css',
    '.csv',
    '.dart',
    '.env',
    '.go',
    '.gql',
    '.graphql',
    '.h',
    '.hpp',
    '.html',
    '.ini',
    '.java',
    '.js',
    '.json',
    '.json5',
    '.jsonl',
    '.jsx',
    '.kt',
    '.kts',
    '.less',
    '.log',
    '.lua',
    '.md',
    '.mdx',
    '.mjs',
    '.mm',
    '.php',
    '.plist',
    '.properties',
    '.proto',
    '.py',
    '.pyi',
    '.r',
    '.rb',
    '.rs',
    '.scss',
    '.sh',
    '.sql',
    '.swift',
    '.toml',
    '.ts',
    '.tsx',
    '.txt',
    '.vue',
    '.xml',
    '.yaml',
    '.yml',
    '.zsh',
]);
const BINARY_EXTENSIONS = new Set([
    '.7z',
    '.aac',
    '.bin',
    '.bmp',
    '.db',
    '.doc',
    '.docx',
    '.dylib',
    '.exe',
    '.flac',
    '.gz',
    '.key',
    '.m4a',
    '.mkv',
    '.mov',
    '.mp3',
    '.mp4',
    '.ogg',
    '.pdf',
    '.png',
    '.ppt',
    '.pptx',
    '.so',
    '.sqlite',
    '.tar',
    '.wasm',
    '.wav',
    '.webm',
    '.webp',
    '.xls',
    '.xlsx',
    '.xlsm',
    '.zip',
]);
export async function readWorkspaceFile(workspace, filePath) {
    return (await readWorkspaceFileOutcome(workspace, filePath)).value;
}
async function readWorkspaceFileOutcome(workspace, filePath) {
    const absolute = await resolveWorkspacePath(workspace, filePath);
    if (!absolute) {
        return {
            value: { type: 'binary', content: '', error: 'Path traversal denied' },
            readSucceeded: false,
        };
    }
    if (isKnownBinaryExtension(filePath)) {
        return { value: { type: 'binary', content: '' }, readSucceeded: true };
    }
    try {
        const bytes = await readFile(absolute);
        if (isWorkspaceFileBinary(filePath, bytes)) {
            return { value: { type: 'binary', content: '' }, readSucceeded: true };
        }
        const decoded = decodeWorkspaceText(bytes);
        return {
            value: { type: 'text', content: decoded.content, encoding: decoded.encoding },
            readSucceeded: true,
        };
    }
    catch {
        return { value: { type: 'text', content: '' }, readSucceeded: false };
    }
}
export async function resolveWorkspacePath(workspace, child) {
    const root = resolve(workspace);
    const target = resolveInside(root, child);
    if (!target)
        return undefined;
    try {
        const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(target)]);
        return isPathInside(realRoot, realTarget) ? realTarget : undefined;
    }
    catch {
        return undefined;
    }
}
export async function resolveWorkspaceWritePath(workspace, child) {
    const lexicalRoot = resolve(workspace);
    const lexicalTarget = resolveInside(lexicalRoot, child);
    if (!lexicalTarget)
        return undefined;
    try {
        const realRoot = await realpath(lexicalRoot);
        const realParent = await createValidatedParent(realRoot, dirname(lexicalTarget));
        if (!realParent)
            return undefined;
        const target = join(realParent, basename(lexicalTarget));
        const existing = await realpathOrFallback(target);
        return isPathInside(realRoot, existing) ? target : undefined;
    }
    catch {
        return undefined;
    }
}
async function createValidatedParent(realRoot, requestedParent) {
    const ancestor = await findExistingAncestor(requestedParent);
    if (!ancestor || !isPathInside(realRoot, ancestor.realPath))
        return undefined;
    let safeParent = ancestor.realPath;
    for (const segment of ancestor.missingSegments) {
        const next = join(safeParent, segment);
        try {
            await mkdir(next);
        }
        catch (error) {
            if (!isAlreadyExistsError(error))
                return undefined;
        }
        let realNext;
        try {
            realNext = await realpath(next);
        }
        catch {
            return undefined;
        }
        if (!isPathInside(realRoot, realNext))
            return undefined;
        safeParent = realNext;
    }
    return safeParent;
}
async function findExistingAncestor(requestedParent) {
    const missingSegments = [];
    let existingAncestor = requestedParent;
    for (;;) {
        try {
            return { realPath: await realpath(existingAncestor), missingSegments };
        }
        catch {
            const parent = dirname(existingAncestor);
            if (parent === existingAncestor)
                return undefined;
            missingSegments.unshift(basename(existingAncestor));
            existingAncestor = parent;
        }
    }
}
function isAlreadyExistsError(error) {
    return error?.code === 'EEXIST';
}
async function realpathOrFallback(target) {
    try {
        return await realpath(target);
    }
    catch {
        return target;
    }
}
export function isKnownBinaryExtension(filePath) {
    const ext = extname(filePath).toLowerCase();
    return BINARY_EXTENSIONS.has(ext);
}
function isKnownTextExtension(filePath) {
    return TEXT_EXTENSIONS.has(extname(filePath).toLowerCase());
}
export function isWorkspaceFileBinary(filePath, bytes, partial = false) {
    if (isKnownBinaryExtension(filePath))
        return true;
    if (isKnownTextExtension(filePath))
        return hasBinarySentinel(bytes);
    return isProbablyBinary(bytes, partial);
}
export function decodeWorkspaceText(bytes) {
    if (hasPrefix(bytes, [0xff, 0xfe])) {
        return { content: decode(bytes, 'utf-16le'), encoding: 'utf-16le' };
    }
    if (hasPrefix(bytes, [0xfe, 0xff])) {
        return { content: decode(bytes, 'utf-16be'), encoding: 'utf-16be' };
    }
    try {
        return {
            content: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
            encoding: 'utf-8',
        };
    }
    catch {
        const declaredEncoding = detectDeclaredEncoding(bytes);
        if (declaredEncoding) {
            try {
                return {
                    content: decode(bytes, declaredEncoding),
                    encoding: declaredEncoding,
                };
            }
            catch {
                // Fall through to the common legacy encodings below.
            }
        }
        try {
            return { content: decode(bytes, 'gb18030'), encoding: 'gb18030' };
        }
        catch {
            return { content: decode(bytes, 'windows-1252'), encoding: 'windows-1252' };
        }
    }
}
export function isPathInside(root, target) {
    const rel = relative(root, target);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}
function resolveInside(root, child) {
    const target = isAbsolute(child) ? resolve(child) : resolve(root, child);
    return isPathInside(root, target) ? target : undefined;
}
function isProbablyBinary(bytes, partial = false) {
    if (bytes.length === 0)
        return false;
    if (hasBinarySentinel(bytes))
        return true;
    try {
        if (hasUtf16Bom(bytes)) {
            return hasBinarySentinel(Buffer.from(decodeWorkspaceText(bytes).content, 'utf8'));
        }
        new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: partial });
    }
    catch {
        return true;
    }
    return false;
}
function hasBinarySentinel(bytes) {
    if (bytes.length === 0)
        return false;
    if (hasUtf16Bom(bytes))
        return false;
    if (bytes.includes(0))
        return true;
    const sampleLength = Math.min(bytes.length, 8_000);
    let controlBytes = 0;
    for (let index = 0; index < sampleLength; index += 1) {
        const byte = bytes[index];
        if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 12 && byte !== 13)
            controlBytes += 1;
    }
    return controlBytes / sampleLength > 0.3;
}
function hasUtf16Bom(bytes) {
    return hasPrefix(bytes, [0xff, 0xfe]) || hasPrefix(bytes, [0xfe, 0xff]);
}
function hasPrefix(bytes, prefix) {
    return prefix.every((byte, index) => bytes[index] === byte);
}
function decode(bytes, encoding) {
    return new TextDecoder(encoding, { fatal: true }).decode(bytes);
}
function detectDeclaredEncoding(bytes) {
    const header = Array.from(bytes.subarray(0, 512), (byte) => String.fromCharCode(byte)).join('');
    const declared = /(?:coding|charset|encoding)\s*[:=]\s*["']?([\w.-]+)/iu.exec(header)?.[1];
    if (!declared)
        return undefined;
    const normalized = declared.toLowerCase().replaceAll('_', '-');
    const aliases = {
        cp936: 'gb18030',
        gb2312: 'gb18030',
        gbk: 'gb18030',
        latin1: 'windows-1252',
        'latin-1': 'windows-1252',
        sjis: 'shift_jis',
        'shift-jis': 'shift_jis',
        utf8: 'utf-8',
    };
    return aliases[normalized] ?? normalized;
}
//# sourceMappingURL=workspace-path.js.map