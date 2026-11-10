import { mkdir, readdir, readFile, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, relative, resolve } from 'node:path';
import { createDefaultTokenEstimator } from '@mavis/context-manager';
import { assertWithinWorkspace } from './path-guard.js';
import { readCloudCompatibleToolResponse, readExplicitCloudCodexToolResponse, withCloudCompatibleToolResponseDetails, withCloudCodexToolResponseDetails, } from './cloud-plugin-hook-response.js';
export const TOOL_RESULT_RAW_ARTIFACT = Symbol.for('mavis.cloud.toolResultRawArtifact');
const TOOL_RESULTS_SUBDIR = join('.mavis', 'tool-results');
const DEFAULT_PER_RESULT_TOKEN_CAP = 16_000;
export const DEFAULT_TOOL_RESULT_ARTIFACT_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const DEFAULT_CHUNK_SIZE_BYTES = 512 * 1024;
const DEFAULT_RAW_ARTIFACT_MAX_BYTES = 5 * 1024 * 1024;
const STRATEGY = 'global_head_tail';
const preparedToolResultRoots = new Set();
export async function cleanupExpiredToolResultArtifacts(workspaceRootInput, nowMs = Date.now(), options = {}) {
    if (!workspaceRootInput) {
        throw new Error('cloud tool-result artifact cleanup requires workspaceRoot');
    }
    const workspaceRoot = resolve(workspaceRootInput);
    const toolResultsRoot = resolve(workspaceRoot, TOOL_RESULTS_SUBDIR);
    try {
        await assertWithinWorkspace(toolResultsRoot, workspaceRoot);
    }
    catch (err) {
        const code = err.code;
        if (code === 'ENOENT')
            return 0;
        throw err;
    }
    let sessionEntries;
    try {
        sessionEntries = await readdir(toolResultsRoot, { withFileTypes: true });
    }
    catch (err) {
        const code = err.code;
        if (code === 'ENOENT')
            return 0;
        throw err;
    }
    const orphanGraceMs = Math.max(0, Math.floor(options.orphanGraceMs ?? DEFAULT_TOOL_RESULT_ARTIFACT_TTL_MS));
    let removed = 0;
    for (const sessionEntry of sessionEntries) {
        if (!sessionEntry.isDirectory())
            continue;
        const sessionDir = resolve(toolResultsRoot, sessionEntry.name);
        await assertWithinWorkspace(sessionDir, workspaceRoot);
        let artifactEntries;
        try {
            artifactEntries = await readdir(sessionDir, { withFileTypes: true });
        }
        catch (err) {
            const code = err.code;
            if (code === 'ENOENT')
                continue;
            throw err;
        }
        for (const artifactEntry of artifactEntries) {
            if (!artifactEntry.isDirectory())
                continue;
            const artifactDir = resolve(sessionDir, artifactEntry.name);
            await assertWithinWorkspace(artifactDir, workspaceRoot);
            const manifest = await readArtifactManifest(join(artifactDir, 'manifest.json'));
            const expiredByManifest = manifest?.expires_at_ms !== undefined && manifest.expires_at_ms <= nowMs;
            const expiredAsStaleOrphan = manifest?.expires_at_ms === undefined &&
                (await isStaleArtifactDir(artifactDir, nowMs, orphanGraceMs));
            if (expiredByManifest || expiredAsStaleOrphan) {
                await rm(artifactDir, { recursive: true, force: true });
                removed += 1;
            }
        }
        await removeSessionDirIfEmpty(sessionDir);
    }
    return removed;
}
export function withToolResultTruncation(tool, options = {}) {
    return {
        ...tool,
        impl: {
            execute: async (ctx, input, signal, onUpdate) => {
                const result = await tool.impl.execute(ctx, input, signal, onUpdate);
                return applyToolResultTruncation(ctx, result, options);
            },
        },
    };
}
export async function applyToolResultTruncation(ctx, result, options = {}) {
    // The raw-artifact channel is symbol-keyed and intentionally stripped from
    // public details below; read it from the original object before sanitizing.
    const rawArtifact = readRawArtifact(result.details);
    // Compatible PostToolUse needs the exact vendor response even when this wrapper
    // rewrites the model-visible preview. Preserve its private symbol channel;
    // never copy it into public/persisted details.
    const compatibleToolResponse = readCloudCompatibleToolResponse(result);
    // Only explicit Codex responses need preservation. Text-only results are
    // recomputed from the final (possibly truncated) model-facing content.
    const explicitCodexToolResponse = readExplicitCloudCodexToolResponse(result);
    const sanitizedDetails = sanitizeDetails(result.details);
    let details = compatibleToolResponse
        ? withCloudCompatibleToolResponseDetails(sanitizedDetails, compatibleToolResponse)
        : sanitizedDetails;
    if (explicitCodexToolResponse !== undefined) {
        details = withCloudCodexToolResponseDetails(details, explicitCodexToolResponse);
    }
    const tokenEstimator = options.tokenEstimator ?? createDefaultTokenEstimator();
    const originalText = collectToolResultText(result);
    const originalTokens = estimateToolResultTokens(tokenEstimator, ctx, result.tool_name, originalText);
    const originalBytes = byteLength(originalText);
    const perResultCap = Math.max(1, Math.floor(options.perResultTokenCap ?? DEFAULT_PER_RESULT_TOKEN_CAP));
    // Each tool result is sized independently against its own per-result cap.
    // There is no shared per-turn budget — earlier large results cannot starve
    // later ones in the same turn. Context-window safety is enforced upstream
    // by ContextLifecycleManager (input tokens) and CloudModelResolver
    // (`max_tokens`), so the per-result cap is purely a single-result preview
    // budget, not a turn-wide rationing mechanism.
    const effectiveCap = perResultCap;
    const needsTextTruncation = originalTokens > effectiveCap;
    const needsArtifact = needsTextTruncation || rawArtifact !== undefined;
    if (!needsArtifact) {
        return details ? { ...result, details } : result;
    }
    const nowMs = options.nowMs ?? Date.now;
    const artifact = await writeToolResultArtifact(ctx, result, {
        originalText,
        rawArtifact,
        tokenEstimator,
        nowMs,
        ttlMs: options.ttlMs ?? DEFAULT_TOOL_RESULT_ARTIFACT_TTL_MS,
        chunkSizeBytes: options.chunkSizeBytes ?? DEFAULT_CHUNK_SIZE_BYTES,
        rawArtifactMaxBytes: options.rawArtifactMaxBytes ?? DEFAULT_RAW_ARTIFACT_MAX_BYTES,
        idGenerator: options.idGenerator ?? randomUUID,
    });
    const artifactDetails = toPublicArtifactDetails(artifact);
    let previewTruncated = needsTextTruncation;
    let baseNotice = buildNotice({
        truncated: needsTextTruncation,
        originalTokens,
        tokenCap: effectiveCap,
        originalBytes,
        artifact,
    });
    let previewText;
    if (needsTextTruncation) {
        previewText = buildHeadTailPreview(tokenEstimator, ctx, result.tool_name, originalText, effectiveCap, baseNotice);
    }
    else {
        const candidate = buildUntruncatedPreview(originalText, baseNotice);
        if (effectiveCap > 0 &&
            estimateToolResultTokens(tokenEstimator, ctx, result.tool_name, candidate) <= effectiveCap) {
            previewText = candidate;
        }
        else {
            previewTruncated = true;
            baseNotice = buildNotice({
                truncated: true,
                originalTokens,
                tokenCap: effectiveCap,
                originalBytes,
                artifact,
            });
            previewText = buildHeadTailPreview(tokenEstimator, ctx, result.tool_name, originalText, effectiveCap, baseNotice);
        }
    }
    const shownTokens = estimateToolResultTokens(tokenEstimator, ctx, result.tool_name, previewText);
    const shownBytes = byteLength(previewText);
    const truncationDetails = {
        truncated: previewTruncated,
        strategy: previewTruncated ? STRATEGY : 'artifact_reference',
        original_tokens: originalTokens,
        shown_tokens: shownTokens,
        original_bytes: originalBytes,
        shown_bytes: shownBytes,
        token_cap: effectiveCap,
        artifact: artifactDetails,
    };
    return {
        ...result,
        text: previewText,
        content: [{ type: 'text', text: previewText }],
        details: {
            ...(details ?? {}),
            tool_result_truncation: truncationDetails,
        },
    };
}
function sanitizeDetails(details) {
    if (!details)
        return undefined;
    const clean = Object.fromEntries(Object.entries(details));
    return Object.keys(clean).length > 0 ? clean : undefined;
}
function readRawArtifact(details) {
    return details?.[TOOL_RESULT_RAW_ARTIFACT];
}
async function readArtifactManifest(manifestPath) {
    try {
        const parsed = JSON.parse(await readFile(manifestPath, 'utf8'));
        return typeof parsed.expires_at_ms === 'number' ? { expires_at_ms: parsed.expires_at_ms } : {};
    }
    catch {
        return undefined;
    }
}
async function isStaleArtifactDir(artifactDir, nowMs, orphanGraceMs) {
    try {
        const info = await stat(artifactDir);
        return info.mtimeMs + orphanGraceMs <= nowMs;
    }
    catch (err) {
        const code = err.code;
        if (code === 'ENOENT')
            return false;
        throw err;
    }
}
async function removeSessionDirIfEmpty(sessionDir) {
    try {
        const remaining = await readdir(sessionDir);
        if (remaining.length === 0)
            await rmdir(sessionDir);
    }
    catch (err) {
        const code = err.code;
        if (code === 'ENOENT' || code === 'ENOTEMPTY' || code === 'EEXIST')
            return;
        throw err;
    }
}
function collectToolResultText(result) {
    if (result.content.length <= 1)
        return result.text;
    const joinedContent = result.content
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .filter((text) => text.length > 0)
        .join('\n\n');
    return joinedContent.length > 0 ? joinedContent : result.text;
}
function estimateToolResultTokens(tokenEstimator, ctx, toolName, text) {
    const message = {
        role: 'toolResult',
        toolCallId: ctx.toolCallId ?? 'unknown-tool-call',
        toolName,
        content: [{ type: 'text', text }],
        isError: false,
        timestamp: 0,
    };
    return tokenEstimator.estimateMessage(message);
}
function buildHeadTailPreview(tokenEstimator, ctx, toolName, originalText, tokenCap, notice) {
    const noticeOnly = notice.trim();
    if (tokenCap <= 0 ||
        estimateToolResultTokens(tokenEstimator, ctx, toolName, noticeOnly) >= tokenCap) {
        return noticeOnly;
    }
    let low = 0;
    let high = originalText.length;
    let best = noticeOnly;
    while (low <= high) {
        const totalUnits = Math.floor((low + high) / 2);
        const candidate = buildHeadTailCandidate(originalText, totalUnits, notice);
        const tokens = estimateToolResultTokens(tokenEstimator, ctx, toolName, candidate);
        if (tokens <= tokenCap) {
            best = candidate;
            low = totalUnits + 1;
        }
        else {
            high = totalUnits - 1;
        }
    }
    return best;
}
function buildUntruncatedPreview(originalText, notice) {
    return originalText.length > 0 ? `${originalText}\n\n${notice.trim()}` : notice.trim();
}
function buildHeadTailCandidate(text, totalUnits, notice) {
    if (totalUnits <= 0)
        return notice.trim();
    const headUnits = Math.ceil(totalUnits / 2);
    const tailUnits = Math.floor(totalUnits / 2);
    const head = safeSliceStart(text, headUnits).replace(/\s+$/u, '');
    const tail = safeSliceEnd(text, tailUnits).replace(/^\s+/u, '');
    if (!head && !tail)
        return notice.trim();
    if (!head)
        return `${notice}${tail}`.trim();
    if (!tail)
        return `${head}${notice}`.trim();
    return `${head}${notice}${tail}`.trim();
}
function safeSliceStart(text, maxUnits) {
    if (maxUnits <= 0)
        return '';
    let end = Math.min(text.length, maxUnits);
    if (end > 0 && isHighSurrogate(text.charCodeAt(end - 1)))
        end -= 1;
    return text.slice(0, end);
}
function safeSliceEnd(text, maxUnits) {
    if (maxUnits <= 0)
        return '';
    let start = Math.max(0, text.length - maxUnits);
    if (start < text.length && isLowSurrogate(text.charCodeAt(start)))
        start += 1;
    return text.slice(start);
}
function isHighSurrogate(code) {
    return code >= 0xd800 && code <= 0xdbff;
}
function isLowSurrogate(code) {
    return code >= 0xdc00 && code <= 0xdfff;
}
function buildNotice(input) {
    const action = input.truncated
        ? `ToolResult truncated with ${STRATEGY}.`
        : 'ToolResult contains a non-text/raw artifact reference.';
    return [
        '',
        '[ToolResult artifact notice]',
        action,
        `original_tokens=${input.originalTokens}; token_cap=${input.tokenCap}; original_bytes=${input.originalBytes}`,
        `artifact_dir=${input.artifact.relativeDir}`,
        `artifact_manifest=${input.artifact.manifestPath}`,
        `artifact_chunks=${input.artifact.chunksDir}`,
        'Use grep/read/bash with the artifact directory when omitted content is needed.',
        '[/ToolResult artifact notice]',
        '',
    ].join('\n');
}
async function writeToolResultArtifact(ctx, result, options) {
    if (!ctx.workspaceRoot) {
        throw new Error('cloud tool-result truncation requires ctx.workspaceRoot');
    }
    const workspaceRoot = resolve(ctx.workspaceRoot);
    const sessionSegment = sanitizePathSegment(ctx.sessionId);
    const toolCallSegment = sanitizePathSegment(ctx.toolCallId ?? `${result.tool_name}-${options.idGenerator()}`);
    const toolResultsRoot = resolve(workspaceRoot, TOOL_RESULTS_SUBDIR);
    const sessionDir = resolve(toolResultsRoot, sessionSegment);
    await assertWithinWorkspace(sessionDir, workspaceRoot);
    await ensureLocalArtifactRoot(toolResultsRoot);
    const artifactDir = await createUniqueArtifactDir(sessionDir, toolCallSegment, options.idGenerator);
    await mkdir(join(artifactDir, 'chunks'), { recursive: true });
    const chunks = splitUtf8Chunks(options.originalText, options.chunkSizeBytes);
    await Promise.all(chunks.map((chunk, i) => writeFile(join(artifactDir, 'chunks', `${String(i).padStart(6, '0')}.txt`), chunk, 'utf8')));
    let rawWrite;
    if (options.rawArtifact) {
        rawWrite = prepareRawArtifactWrite(options.rawArtifact, options.rawArtifactMaxBytes);
        await writeFile(join(artifactDir, rawWrite.filename), rawWrite.text, 'utf8');
    }
    const now = options.nowMs();
    const expiresAtMs = now + options.ttlMs;
    const relativeDir = normalizeRelative(relative(workspaceRoot, artifactDir));
    const chunksDir = normalizeRelative(join(relativeDir, 'chunks'));
    const manifest = {
        version: 1,
        kind: 'tool_result_artifact',
        session_id: ctx.sessionId,
        turn_id: ctx.turnId,
        tool_call_id: ctx.toolCallId ?? null,
        tool_name: result.tool_name,
        strategy: STRATEGY,
        created_at_ms: now,
        expires_at_ms: expiresAtMs,
        original_tokens: estimateToolResultTokens(options.tokenEstimator, ctx, result.tool_name, options.originalText),
        original_bytes: byteLength(options.originalText),
        chunk_size_bytes: options.chunkSizeBytes,
        chunk_count: chunks.length,
        chunks_dir: 'chunks',
        ...(rawWrite
            ? {
                raw_filename: rawWrite.filename,
                raw_media_type: rawWrite.mediaType ?? null,
                raw_truncated: rawWrite.truncated,
                raw_original_bytes: rawWrite.originalBytes,
                raw_written_bytes: rawWrite.writtenBytes,
            }
            : {}),
    };
    const manifestTmp = join(artifactDir, 'manifest.tmp');
    const manifestJson = join(artifactDir, 'manifest.json');
    await writeFile(manifestTmp, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    await rename(manifestTmp, manifestJson);
    return {
        relativeDir,
        manifestPath: normalizeRelative(join(relativeDir, 'manifest.json')),
        chunksDir,
        expiresAtMs,
        chunkCount: chunks.length,
        chunkSizeBytes: options.chunkSizeBytes,
        ...(rawWrite
            ? {
                rawFilename: rawWrite.filename,
                rawTruncated: rawWrite.truncated,
                rawOriginalBytes: rawWrite.originalBytes,
                rawWrittenBytes: rawWrite.writtenBytes,
            }
            : {}),
    };
}
function toPublicArtifactDetails(artifact) {
    return {
        relative_dir: artifact.relativeDir,
        manifest_path: artifact.manifestPath,
        chunks_dir: artifact.chunksDir,
        expires_at_ms: artifact.expiresAtMs,
        chunk_count: artifact.chunkCount,
        chunk_size_bytes: artifact.chunkSizeBytes,
        ...(artifact.rawFilename ? { raw_filename: artifact.rawFilename } : {}),
        ...(artifact.rawTruncated !== undefined
            ? {
                raw_truncated: artifact.rawTruncated,
                raw_original_bytes: artifact.rawOriginalBytes,
                raw_written_bytes: artifact.rawWrittenBytes,
            }
            : {}),
    };
}
async function createUniqueArtifactDir(sessionDir, preferredSegment, idGenerator) {
    await mkdir(sessionDir, { recursive: true });
    const first = resolve(sessionDir, preferredSegment);
    try {
        await mkdir(first);
        return first;
    }
    catch (err) {
        const code = err.code;
        if (code !== 'EEXIST')
            throw err;
    }
    for (let attempt = 0; attempt < 8; attempt += 1) {
        const suffix = sanitizePathSegment(idGenerator()).slice(0, 16);
        const candidate = resolve(sessionDir, `${preferredSegment}-${suffix}`);
        try {
            await mkdir(candidate);
            return candidate;
        }
        catch (err) {
            const code = err.code;
            if (code !== 'EEXIST')
                throw err;
        }
    }
    throw new Error(`tool-result artifact path already exists for ${preferredSegment}`);
}
async function ensureLocalArtifactRoot(toolResultsRoot) {
    const root = resolve(toolResultsRoot);
    if (preparedToolResultRoots.has(root))
        return;
    await mkdir(root, { recursive: true });
    await writeFile(join(root, '.gitignore'), '*\n', 'utf8');
    preparedToolResultRoots.add(root);
}
function serializeRawArtifact(value) {
    if (typeof value === 'string')
        return value;
    try {
        return `${JSON.stringify(value, null, 2)}\n`;
    }
    catch {
        return `${String(value)}\n`;
    }
}
function prepareRawArtifactWrite(rawArtifact, maxBytes) {
    const filename = sanitizeFilename(rawArtifact.filename ?? 'raw.json');
    const serialized = serializeRawArtifact(rawArtifact.value);
    const originalBytes = byteLength(serialized);
    const safeMaxBytes = Math.max(1, Math.floor(maxBytes));
    if (originalBytes <= safeMaxBytes) {
        return {
            filename,
            text: serialized,
            originalBytes,
            writtenBytes: originalBytes,
            truncated: false,
            ...(rawArtifact.mediaType ? { mediaType: rawArtifact.mediaType } : {}),
        };
    }
    const notice = `\n\n[raw artifact truncated: original_bytes=${originalBytes}; max_bytes=${safeMaxBytes}]\n`;
    const prefix = safeSliceUtf8(serialized, Math.max(0, safeMaxBytes - byteLength(notice)));
    const text = `${prefix}${notice}`;
    return {
        filename,
        text,
        originalBytes,
        writtenBytes: byteLength(text),
        truncated: true,
        ...(rawArtifact.mediaType ? { mediaType: rawArtifact.mediaType } : {}),
    };
}
function splitUtf8Chunks(text, maxBytes) {
    if (text.length === 0)
        return [''];
    const chunks = [];
    let start = 0;
    while (start < text.length) {
        let low = start + 1;
        let high = Math.min(text.length, start + maxBytes);
        let best = low;
        while (low <= high) {
            let mid = Math.floor((low + high) / 2);
            if (mid > start && isHighSurrogate(text.charCodeAt(mid - 1)))
                mid -= 1;
            if (mid <= start)
                mid = start + 1;
            const candidate = text.slice(start, mid);
            if (byteLength(candidate) <= maxBytes) {
                best = mid;
                low = mid + 1;
            }
            else {
                high = mid - 1;
            }
        }
        if (best < text.length && isLowSurrogate(text.charCodeAt(best)))
            best += 1;
        chunks.push(text.slice(start, best));
        start = best;
    }
    return chunks;
}
function safeSliceUtf8(text, maxBytes) {
    if (maxBytes <= 0)
        return '';
    let low = 0;
    let high = text.length;
    let best = 0;
    while (low <= high) {
        let mid = Math.floor((low + high) / 2);
        if (mid > 0 && isHighSurrogate(text.charCodeAt(mid - 1)))
            mid -= 1;
        const candidate = text.slice(0, mid);
        if (byteLength(candidate) <= maxBytes) {
            best = mid;
            low = mid + 1;
        }
        else {
            high = mid - 1;
        }
    }
    return text.slice(0, best);
}
function sanitizePathSegment(value) {
    const sanitized = value.replace(/[^A-Za-z0-9._-]/gu, '_').slice(0, 128);
    return sanitized.length > 0 ? sanitized : 'unknown';
}
function sanitizeFilename(value) {
    const basename = value.split(/[\\/]/u).pop() ?? 'raw.json';
    const sanitized = basename.replace(/[^A-Za-z0-9._-]/gu, '_').slice(0, 128);
    return sanitized.length > 0 ? sanitized : 'raw.json';
}
function normalizeRelative(path) {
    return path.split('\\').join('/');
}
function byteLength(text) {
    return Buffer.byteLength(text, 'utf8');
}
//# sourceMappingURL=tool-result-truncation.js.map