import { createHash } from "node:crypto";
import { readFile, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { pptxCoreRuntimeTerminalResponseV1 } from "./protocol";
const SELECTOR_SCHEMA = 'mavis.pptx_wasm_runtime_selector.v1';
const MANIFEST_SCHEMA = 'mavis.pptx_wasm_runtime_manifest.v1';
const HASH = /^[a-f0-9]{64}$/u;
const PREFIX = '/_mavis/pptx-core/';
const MEMBER_SEGMENT = /^[A-Za-z0-9._-]+$/u;
const MAX_ASSET_BYTES = 64 * 1024 * 1024;
const MAX_RUNTIME_BYTES = 256 * 1024 * 1024;
const runtimeCsp = [
    "default-src 'none'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "worker-src 'self'",
    "connect-src 'self'",
].join('; ');
function jsonResponse(value, status = 200) {
    return new Response(JSON.stringify(value), {
        status,
        headers: {
            'Cache-Control': 'no-store',
            'Content-Security-Policy': runtimeCsp,
            'Content-Type': 'application/json',
        },
    });
}
async function readSelector(runtimeRoot) {
    const selector = JSON.parse(await readFile(path.join(runtimeRoot, 'runtime.json'), 'utf8'));
    if (selector?.schema !== SELECTOR_SCHEMA ||
        JSON.stringify(Object.keys(selector).sort()) !==
            JSON.stringify(['runtimeHash', 'schema', 'workerPath'].sort()) ||
        typeof selector.runtimeHash !== 'string' ||
        !selector.runtimeHash.startsWith('sha256:') ||
        !HASH.test(selector.runtimeHash.slice('sha256:'.length)) ||
        selector.workerPath !== `${PREFIX}${selector.runtimeHash.slice('sha256:'.length)}/worker.js`) {
        throw new Error('The PPTX runtime selector is invalid');
    }
    return selector;
}
async function readManifest(runtimeRoot, hash) {
    const manifest = JSON.parse(await readFile(path.join(runtimeRoot, hash, 'manifest.json'), 'utf8'));
    if (manifest.schema !== MANIFEST_SCHEMA ||
        manifest.runtimeHash !== `sha256:${hash}` ||
        JSON.stringify(Object.keys(manifest).sort()) !==
            JSON.stringify([
                'assets',
                'openXmlSdkVersion',
                'profile',
                'runtimeHash',
                'runtimeIdentifier',
                'schema',
                'sdkVersion',
                'wireSchema',
            ].sort()) ||
        manifest.sdkVersion !== '10.0.100' ||
        manifest.runtimeIdentifier !== 'browser-wasm' ||
        manifest.openXmlSdkVersion !== '3.5.1' ||
        manifest.wireSchema !== 'mavis.pptx_source_graph.v1' ||
        !Array.isArray(manifest.assets)) {
        throw new Error('The PPTX runtime manifest is invalid');
    }
    const stable = {
        schema: manifest.schema,
        sdkVersion: manifest.sdkVersion,
        runtimeIdentifier: manifest.runtimeIdentifier,
        openXmlSdkVersion: manifest.openXmlSdkVersion,
        wireSchema: manifest.wireSchema,
        profile: manifest.profile,
        assets: manifest.assets,
    };
    const canonicalHash = createHash('sha256').update(JSON.stringify(stable)).digest('hex');
    if (canonicalHash !== hash)
        throw new Error('The PPTX runtime manifest hash is invalid');
    const exactPaths = new Set();
    const foldedPaths = new Set();
    let totalBytes = 0;
    for (const asset of manifest.assets) {
        if (JSON.stringify(Object.keys(asset).sort()) !==
            JSON.stringify(['mimeType', 'path', 'sha256', 'sizeBytes'].sort()) ||
            !isCanonicalMember(asset.path) ||
            typeof asset.sha256 !== 'string' ||
            !asset.sha256.startsWith('sha256:') ||
            !HASH.test(asset.sha256.slice('sha256:'.length)) ||
            !Number.isSafeInteger(asset.sizeBytes) ||
            asset.sizeBytes < 0 ||
            asset.sizeBytes > MAX_ASSET_BYTES ||
            asset.mimeType !== expectedMimeType(asset.path))
            throw new Error('The PPTX runtime asset manifest is invalid');
        const folded = asset.path.toLocaleLowerCase('en-US');
        if (exactPaths.has(asset.path) || foldedPaths.has(folded))
            throw new Error('The PPTX runtime asset manifest has a path conflict');
        exactPaths.add(asset.path);
        foldedPaths.add(folded);
        totalBytes += asset.sizeBytes;
        if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_RUNTIME_BYTES)
            throw new Error('The PPTX runtime asset manifest exceeds its byte budget');
    }
    return manifest;
}
function expectedMimeType(member) {
    const extension = path.posix.extname(member).toLowerCase();
    if (extension === '.wasm')
        return 'application/wasm';
    if (extension === '.js' || extension === '.mjs')
        return 'text/javascript';
    if (extension === '.json')
        return 'application/json';
    return 'application/octet-stream';
}
function isCanonicalMember(member) {
    return (typeof member === 'string' &&
        member.length > 0 &&
        !member.startsWith('/') &&
        !member.includes('\\') &&
        member
            .split('/')
            .every((segment) => segment !== '.' && segment !== '..' && MEMBER_SEGMENT.test(segment)));
}
function isInside(candidate, root) {
    const relative = path.relative(root, candidate);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
async function readContainedAsset(root, member) {
    let current = root;
    for (const segment of member.split('/')) {
        current = path.join(current, segment);
        if ((await lstat(current)).isSymbolicLink())
            throw new Error('The PPTX runtime asset cannot be a symbolic link');
    }
    const rootRealPath = await realpath(root);
    const assetRealPath = await realpath(current);
    if (!isInside(assetRealPath, rootRealPath))
        throw new Error('The PPTX runtime asset escapes its root');
    return readFile(assetRealPath);
}
function requestMember(pathname) {
    const relative = pathname.slice(PREFIX.length);
    const separator = relative.indexOf('/');
    if (separator < 0)
        return null;
    const hash = relative.slice(0, separator);
    const member = relative.slice(separator + 1);
    if (!HASH.test(hash) || !isCanonicalMember(member)) {
        return null;
    }
    return { hash, member };
}
export function createPptxCoreRuntimeProtocolHandler(options) {
    return async (request) => {
        const url = new URL(request.url);
        if (!url.pathname.startsWith(PREFIX))
            return new Response(null, { status: 404 });
        if (request.method !== 'GET' && request.method !== 'HEAD')
            return new Response(null, { status: 405 });
        if (!options.runtimeRoot)
            return jsonResponse(pptxCoreRuntimeTerminalResponseV1('pptx_core_runtime_unavailable'), 503);
        try {
            const selector = await readSelector(options.runtimeRoot);
            if (url.pathname === `${PREFIX}runtime.json`) {
                const hash = selector.runtimeHash.slice('sha256:'.length);
                return jsonResponse({
                    schema: SELECTOR_SCHEMA,
                    runtimeHash: selector.runtimeHash,
                    workerPath: `${PREFIX}${hash}/worker.js`,
                });
            }
            const parsed = requestMember(url.pathname);
            if (!parsed || selector.runtimeHash !== `sha256:${parsed.hash}`)
                return new Response(null, { status: 404 });
            const manifest = await readManifest(options.runtimeRoot, parsed.hash);
            const asset = manifest.assets.find((candidate) => candidate.path === parsed.member);
            if (!asset || !Number.isSafeInteger(asset.sizeBytes) || asset.sizeBytes < 0)
                return new Response(null, { status: 404 });
            const bytes = await readContainedAsset(path.join(options.runtimeRoot, parsed.hash), parsed.member);
            const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
            if (bytes.byteLength !== asset.sizeBytes || digest !== asset.sha256)
                return jsonResponse(pptxCoreRuntimeTerminalResponseV1('pptx_core_runtime_integrity_failure'), 500);
            return new Response(request.method === 'HEAD' ? null : new Uint8Array(bytes), {
                status: 200,
                headers: {
                    'Cache-Control': 'public, max-age=31536000, immutable',
                    'Content-Length': String(bytes.byteLength),
                    'Content-Security-Policy': runtimeCsp,
                    'Content-Type': asset.mimeType,
                    'Cross-Origin-Resource-Policy': 'same-origin',
                },
            });
        }
        catch {
            return jsonResponse(pptxCoreRuntimeTerminalResponseV1('pptx_core_runtime_unavailable'), 503);
        }
    };
}
