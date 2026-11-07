import { realpath } from 'node:fs/promises';
import { isAbsolute, posix, relative, resolve } from 'node:path';
import { resolvePath } from './path-utils.js';
const JSON_HEADERS = { 'Content-Type': 'application/json' };
export const TEXT_EXTENSIONS = new Set([
    '.css',
    '.csv',
    '.html',
    '.js',
    '.json',
    '.jsonl',
    '.jsx',
    '.log',
    '.md',
    '.mdx',
    '.mjs',
    '.scss',
    '.sh',
    '.ts',
    '.tsx',
    '.txt',
    '.xml',
    '.yaml',
    '.yml',
]);
export const BINARY_EXTENSIONS = new Set([
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
export function normalizeGitActionPath(filePath) {
    const trimmed = filePath.trim();
    if (!trimmed ||
        trimmed.includes('\0') ||
        isAbsolute(trimmed) ||
        /^[a-zA-Z]:[\\/]/u.test(trimmed)) {
        throw new Error(`Invalid git path: ${filePath}`);
    }
    const normalized = posix.normalize(trimmed.replace(/\\/gu, '/'));
    if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
        throw new Error(`Invalid git path: ${filePath}`);
    }
    return normalized;
}
export function gitDiffScopes(scope) {
    return scope === 'staged' || scope === 'unstaged' ? [scope] : ['staged', 'unstaged'];
}
export async function resolveWorkspacePath(workspace, child) {
    const root = resolveWorkspace(workspace);
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
export function resolveWorkspace(workspace) {
    return resolvePath(workspace);
}
export function resolveInside(root, child) {
    const target = isAbsolute(child) ? resolve(child) : resolve(root, child);
    return isPathInside(root, target) ? target : undefined;
}
export function isPathInside(root, target) {
    const rel = relative(root, target);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}
export function requiredQuery(url, key) {
    const value = url.searchParams.get(key);
    return value || json({ error: `${key} is required` }, { status: 400 });
}
export async function readJsonBody(request) {
    try {
        const data = (await request.json());
        return data && typeof data === 'object' && !Array.isArray(data)
            ? data
            : {};
    }
    catch {
        return {};
    }
}
export function readString(data, key) {
    const value = data[key];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}
export function json(data, init) {
    return new Response(JSON.stringify(data), {
        status: init?.status ?? 200,
        statusText: init?.statusText,
        headers: { ...JSON_HEADERS, ...(init?.headers ?? {}) },
    });
}
export function notFound(pathname) {
    return json({ error: `Local runtime route not found: ${pathname}` }, { status: 404 });
}
//# sourceMappingURL=file-api-shared.js.map