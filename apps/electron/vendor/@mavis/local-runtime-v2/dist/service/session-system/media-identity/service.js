import { open, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { getCloudDriveNodeId, isCommitIdTransportId } from '@mavis/shared/asset-markup';
import { deriveMediaKind } from '@mavis/shared/media-asset-meta';
import { createFingerprinter, sameAigcOrigin, sameDimensions, } from './fingerprint.js';
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const IMAGE_VERIFY_TIMEOUT_MS = 15_000;
/** Videos are verified by whole-file SHA256 only, so they get a larger, separate budget. */
const VIDEO_LIMITS = { maxBytes: 256 * 1024 * 1024, timeoutMs: 60_000 };
const MAX_CANDIDATES = 32;
const MAX_CACHED_DIGESTS = 256;
/** PTC tool whose result text ends with the program's JSON return value. */
const RUN_CODE_TOOL_NAME = 'run_code';
/** Nesting searched inside a PTC return value; deeper values are not read. */
const MAX_PROGRAM_VALUE_DEPTH = 8;
const NODE_ID_KEY = 'node_id';
/** Asset metadata keys a delivery can use to name its Drive node. */
const CLAIMED_NODE_KEYS = ['driveNodeId', 'drive_node_id', 'nodeId', 'node_id'];
/** Adds download identity after verifying the delivered file against the session's receipts. */
export class SessionMediaIdentityService {
    options;
    scope;
    digests = new Map();
    pending = new Map();
    constructor(options) {
        this.options = options;
    }
    async enrich(sessionId, delivered) {
        if (!delivered.some((file) => localMediaKind(file)))
            return delivered;
        let history;
        // Claim checks and byte verification read the same history at most once.
        const readHistory = () => {
            history ??= this.options.history.inspectActive(sessionId);
            return history;
        };
        const files = await verifiedClaims(delivered, readHistory);
        const missing = files.filter((file) => localMediaKind(file) && !getCloudDriveNodeId(metadata(file)));
        if (!missing.length)
            return files;
        const cloud = this.options.cloud.capture();
        if (!cloud)
            return files;
        if (this.scope !== cloud.key) {
            this.scope = cloud.key;
            this.digests.clear();
            this.pending.clear();
        }
        try {
            return await this.enrichLocalImages(sessionId, { files, missing }, cloud, readHistory);
        }
        catch {
            return files;
        }
    }
    async enrichLocalImages(sessionId, { files, missing, }, cloud, readHistory) {
        const session = await this.options.sessions.get(sessionId);
        if (!session || !cloud.isCurrent())
            return files;
        const history = await readHistory();
        const candidates = generatedImageNodes(history.messages);
        // Only hash local media of a kind the session actually generated.
        const targets = missing.filter((file) => candidates.some((candidate) => candidate.kind === localMediaKind(file)));
        if (!targets.length)
            return files;
        const root = await realpath(session.workspaceDir);
        const local = await localFingerprints(root, targets);
        if (!local.size || !cloud.isCurrent())
            return files;
        const wanted = new Set([...local.values()].map((item) => item.sha256));
        // Never download origins of a kind no local file can match, e.g. videos for an image list.
        const kinds = new Set([...local.keys()].map(localMediaKind));
        const { matches, readable } = await this.readCandidates(cloud, candidates.filter((candidate) => kinds.has(candidate.kind)), wanted);
        if (!cloud.isCurrent() || !(await this.options.sessions.get(sessionId)))
            return files;
        const byName = nameFallback(candidates, local, matches, readable);
        const byCopy = await copyFallback(root, candidates, local, { matches, readable, byName });
        const enriched = await verifiedIdentities(root, local, { matches, byName, byCopy });
        return cloud.isCurrent() ? files.map((file) => enriched.get(file) ?? file) : files;
    }
    async readDigest(cloud, { nodeId, kind }, signal) {
        const cached = this.digests.get(nodeId);
        if (cached)
            return cached;
        const operation = this.pending.get(nodeId) ??
            (kind === 'video'
                ? cloud.digest(nodeId, signal, VIDEO_LIMITS)
                : cloud.digest(nodeId, signal));
        this.pending.set(nodeId, operation);
        try {
            return await operation;
        }
        finally {
            if (this.pending.get(nodeId) === operation)
                this.pending.delete(nodeId);
        }
    }
    cacheDigest(nodeId, digest) {
        this.digests.set(nodeId, digest);
        if (this.digests.size > MAX_CACHED_DIGESTS) {
            this.digests.delete(this.digests.keys().next().value);
        }
    }
    async readCandidates(cloud, candidates, wanted) {
        const matches = new Map();
        const readable = new Map();
        const signal = AbortSignal.timeout(candidates.some((candidate) => candidate.kind === 'video')
            ? VIDEO_LIMITS.timeoutMs
            : IMAGE_VERIFY_TIMEOUT_MS);
        // Prefer recent receipts, with a small shared worker pool. Cloud failures leave local
        // previews usable and are retried next time, never cached as a successful association.
        let next = 0;
        await Promise.all(Array.from({ length: Math.min(3, candidates.length) }, async () => {
            while (next < candidates.length && !signal.aborted && cloud.isCurrent()) {
                const candidate = candidates[next++];
                const { nodeId } = candidate;
                try {
                    const digest = await this.readDigest(cloud, candidate, signal);
                    if (!cloud.isCurrent() || this.scope !== cloud.key)
                        return;
                    this.cacheDigest(nodeId, digest);
                    readable.set(nodeId, digest);
                    recordByteMatch(matches, wanted, nodeId, digest);
                }
                catch {
                    /* An unavailable or mismatched origin is not a local-file failure. */
                }
            }
        }));
        return { matches, readable };
    }
}
/**
 * A delivered local file may name its cloud resource itself, e.g. `<media node_id>`.
 * The model writes that markup, so the identity is kept only when the same node of
 * the same media kind appears in one of this session's successful generation
 * receipts. Neither bytes nor the workspace location are checked: the receipt
 * proves the session produced the resource, and the file may be renamed, moved
 * outside the workspace, or saved under an older watermark setting. Otherwise the
 * claim is dropped and the file goes through the ordinary verification.
 */
async function verifiedClaims(files, readHistory) {
    const claims = files.filter((file) => localMediaKind(file) && getCloudDriveNodeId(metadata(file)));
    if (!claims.length)
        return files;
    let receipts = new Map();
    try {
        receipts = new Map(generatedImageNodes((await readHistory()).messages, Infinity).map((node) => [
            node.nodeId,
            node.kind,
        ]));
    }
    catch {
        /* Without readable receipts no claim is proven. */
    }
    const rejected = new Set(claims.filter((file) => receipts.get(getCloudDriveNodeId(metadata(file))) !== localMediaKind(file)));
    return rejected.size
        ? files.map((file) => (rejected.has(file) ? withoutClaimedIdentity(file) : file))
        : files;
}
function withoutClaimedIdentity(file) {
    try {
        const value = JSON.parse(file.dataJson);
        if (!value || typeof value !== 'object' || Array.isArray(value))
            return file;
        const rest = { ...value };
        for (const key of CLAIMED_NODE_KEYS)
            delete rest[key];
        if (typeof rest.artifactId === 'string' && isCommitIdTransportId(rest.artifactId))
            delete rest.artifactId;
        return { ...file, dataJson: JSON.stringify(rest) };
    }
    catch {
        return file;
    }
}
function recordByteMatch(matches, wanted, nodeId, digest) {
    if (!wanted.has(digest.sha256))
        return;
    const previous = matches.get(digest.sha256);
    matches.set(digest.sha256, previous === undefined || previous === nodeId ? nodeId : null);
}
async function localFingerprints(root, files) {
    const local = new Map();
    // File reads are serialized and bounded; never follow a delivery outside its workspace.
    for (const file of files) {
        const fingerprint = await tryLocalFingerprint(root, file.path, maxBytesOf(file));
        if (fingerprint)
            local.set(file, fingerprint);
    }
    return local;
}
async function verifiedIdentities(root, local, evidence) {
    const { matches, byName, byCopy } = evidence;
    const enriched = new Map();
    for (const [file, fingerprint] of local) {
        const copy = byCopy.get(file);
        const nodeId = matches.get(fingerprint.sha256) ?? byName.get(file) ?? copy?.nodeId;
        // Recheck both the delivery and any source used to prove a renamed copy.
        if (nodeId &&
            (await tryLocalFingerprint(root, file.path, maxBytesOf(file)))?.sha256 ===
                fingerprint.sha256 &&
            (await unchangedCopySource(root, copy))) {
            enriched.set(file, {
                ...file,
                dataJson: JSON.stringify({ ...metadata(file), driveNodeId: nodeId }),
            });
        }
    }
    return enriched;
}
async function unchangedCopySource(root, copy) {
    if (!copy)
        return true;
    return (await tryLocalFingerprint(root, copy.path))?.sha256 === copy.fingerprint.sha256;
}
async function tryLocalFingerprint(root, filePath, maxBytes = MAX_IMAGE_BYTES) {
    try {
        return await localFingerprint(root, filePath, maxBytes);
    }
    catch {
        return undefined;
    }
}
function metadata(file) {
    try {
        return { ...JSON.parse(file.dataJson), path: file.path };
    }
    catch {
        return { path: file.path };
    }
}
function localMediaKind(file) {
    if (/^(?:[a-z][a-z\d+.-]*:|commit-id-)/iu.test(file.path.replace(/^[a-z]:[\\/]/iu, '/')))
        return undefined;
    const kind = deriveMediaKind({
        path: file.path,
        name: file.name ?? undefined,
        type: file.assetType ?? undefined,
    });
    return kind === 'image' || kind === 'video' ? kind : undefined;
}
function maxBytesOf(file) {
    return localMediaKind(file) === 'video' ? VIDEO_LIMITS.maxBytes : MAX_IMAGE_BYTES;
}
/**
 * Watermark settings change the bytes a node serves after the local file was saved,
 * so a byte mismatch alone does not disprove identity. Fall back to the receipt file
 * name only when it is unambiguous on both sides, the current account can read the
 * node, and either the image dimensions and generator label agree or, for a video,
 * the name is the receipt's own `<taskId>.<ext>`.
 */
function nameFallback(candidates, local, matches, readable) {
    const result = new Map();
    const claimed = new Set([...matches.values()].filter((node) => Boolean(node)));
    const nodesByName = groupBy(candidates, (candidate) => candidate.fileName);
    const filesByName = groupBy([...local.keys()], (file) => fileBasename(file.path));
    for (const [file, fingerprint] of local) {
        // Byte evidence, including an ambiguous byte match, takes precedence.
        if (matches.has(fingerprint.sha256))
            continue;
        const name = fileBasename(file.path);
        const named = nodesByName.get(name) ?? [];
        const nodeIds = new Set(named.map((candidate) => candidate.nodeId));
        const [nodeId] = nodeIds;
        if (nodeIds.size !== 1 || filesByName.get(name)?.length !== 1 || !nodeId)
            continue;
        if (!claimed.has(nodeId) && corroborates(file, fingerprint, named, readable.get(nodeId)))
            result.set(file, nodeId);
    }
    return result;
}
/**
 * Images must match the readable node's raster and still carry its generator label,
 * which re-encoding edits usually drop; videos, which have neither, its task file name.
 */
function corroborates(file, fingerprint, named, cloud) {
    const kind = localMediaKind(file);
    if (!cloud || !named.length || named.some((node) => node.kind !== kind))
        return false;
    return kind === 'video'
        ? named.every((node) => isTaskFileName(node))
        : sameDimensions(cloud.dimensions, fingerprint.dimensions) &&
            sameAigcOrigin(cloud.aigc, fingerprint.aigc);
}
/** A renamed delivery can use a receipt only when its workspace source proves the copy. */
async function copyFallback(root, candidates, local, evidence) {
    const result = new Map();
    const { matches, readable, byName } = evidence;
    const unresolved = [...local].filter(([file, fingerprint]) => !matches.has(fingerprint.sha256) && !byName.has(file));
    // At the receipt limit, unseen nodes could make an apparent copy ambiguous.
    if (candidates.length >= MAX_CANDIDATES || !unresolved.length)
        return result;
    // Copy proof relies on raster dimensions, which only images have.
    const sources = await copySources(root, candidates.filter((candidate) => candidate.kind === 'image'));
    const claimed = new Set([...matches.values(), ...byName.values()].filter((node) => Boolean(node)));
    for (const [file, fingerprint] of unresolved) {
        const source = uniqueCopySource(sources.get(fingerprint.sha256));
        if (usableCopySource(source, fingerprint, readable, claimed))
            result.set(file, source);
    }
    return result;
}
async function copySources(root, candidates) {
    const sources = new Map();
    for (const [path, nodes] of groupBy(candidates, (candidate) => candidate.fileName)) {
        const fingerprint = await tryLocalFingerprint(root, path);
        if (!fingerprint)
            continue;
        // Include every receipt node before checking cloud readability. A failed cloud read
        // must never turn multiple same-byte origins into an apparently unique association.
        const copies = nodes.map(({ nodeId }) => ({ nodeId, path, fingerprint }));
        sources.set(fingerprint.sha256, [...(sources.get(fingerprint.sha256) ?? []), ...copies]);
    }
    return sources;
}
function uniqueCopySource(sources) {
    const nodeIds = new Set(sources?.map((source) => source.nodeId));
    return nodeIds.size === 1 ? sources?.[0] : undefined;
}
function usableCopySource(source, delivery, readable, claimed) {
    return Boolean(source &&
        !claimed.has(source.nodeId) &&
        sameDimensions(source.fingerprint.dimensions, delivery.dimensions) &&
        sameDimensions(readable.get(source.nodeId)?.dimensions, source.fingerprint.dimensions) &&
        sameAigcOrigin(readable.get(source.nodeId)?.aigc, source.fingerprint.aigc));
}
function groupBy(items, key) {
    const groups = new Map();
    for (const item of items)
        groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
    return groups;
}
function fileBasename(path) {
    return basename(path.replace(/\\/gu, '/'));
}
async function localFingerprint(root, filePath, maxBytes) {
    const path = await realpath(resolve(root, filePath));
    if (!isWorkspaceChild(root, path))
        return undefined;
    const file = await open(path, 'r');
    try {
        const before = await file.stat();
        if (!before.isFile() || before.size <= 0 || before.size > maxBytes)
            return undefined;
        const fingerprint = createFingerprinter();
        let size = 0;
        for await (const chunk of file.createReadStream({ autoClose: false })) {
            size += chunk.length;
            if (size > maxBytes)
                return undefined;
            fingerprint.update(chunk);
        }
        const after = await stat(path);
        if (!unchangedFile(before, after, size))
            return undefined;
        return fingerprint.finish();
    }
    finally {
        await file.close();
    }
}
function isWorkspaceChild(root, path) {
    const child = relative(root, path);
    return Boolean(child) && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}
function unchangedFile(before, after, bytesRead) {
    return (before.size === after.size &&
        before.mtimeMs === after.mtimeMs &&
        before.ctimeMs === after.ctimeMs &&
        before.ino === after.ino &&
        before.dev === after.dev &&
        bytesRead === before.size);
}
/**
 * Only successful generation receipts supply candidates. The receipt file name is kept
 * for the guarded fallback; it never establishes identity without the other checks.
 */
function generatedImageNodes(messages, limit = MAX_CANDIDATES) {
    const nodes = new Map();
    for (const message of [...messages].reverse()) {
        for (const node of messageImageNodes(message)) {
            // Receipts are scanned newest first; the first receipt for a node keeps its name.
            nodes.set(node.nodeId, nodes.get(node.nodeId) ?? node);
            if (nodes.size >= limit)
                return [...nodes.values()];
        }
    }
    return [...nodes.values()];
}
function* messageImageNodes(value) {
    const message = record(value);
    if (message?.role !== 'toolResult' || message.isError === true || !Array.isArray(message.content))
        return;
    for (const part of message.content) {
        for (const item of generationReceiptItems(message, part)) {
            const node = imageNode(item);
            if (node)
                yield node;
        }
    }
}
function generationReceiptItems(message, part) {
    const text = record(part);
    if (text?.type !== 'text' || typeof text.text !== 'string' || text.text.length > 256 * 1024)
        return [];
    const items = receiptTextItems(generationResultText(message, text.text));
    return message.toolName === RUN_CODE_TOOL_NAME
        ? [...items, ...programReceiptItems(text.text)]
        : items;
}
function receiptTextItems(output) {
    // Only text starting with an object can be one; skip parsing prose and paths.
    const result = /^\s*\{/u.test(output) ? parseRecord(output) : undefined;
    if (result)
        return receiptAssets(result);
    // Generation scripts may log progress around the receipt. Accept only a receipt that
    // occupies a whole line by itself; JSON embedded in prose stays invalid.
    return output.split(/\r?\n/u).flatMap((line) => {
        const trimmed = line.trim();
        const receipt = trimmed.startsWith('{') && trimmed.endsWith('}') ? parseRecord(trimmed) : undefined;
        return receipt ? receiptAssets(receipt) : [];
    });
}
/**
 * A PTC `run_code` result keeps no child outputs of its own: the tool output a program read
 * reaches history only inside its JSON return value, the last line of the result text after
 * host notes and console output. A shortened value ends with a note instead and is not read.
 */
function programReceiptItems(text) {
    // Every receipt names its node; most program results never mention one.
    if (!text.includes(NODE_ID_KEY))
        return [];
    const value = parseJson(text.slice(text.lastIndexOf('\n') + 1));
    return value === undefined ? [] : programValueReceipts(value, 0);
}
/** Returned objects may themselves be receipts; returned strings keep the text rules above. */
function programValueReceipts(value, depth) {
    if (depth > MAX_PROGRAM_VALUE_DEPTH)
        return [];
    if (typeof value === 'string')
        return programTextReceipts(value, depth);
    if (Array.isArray(value))
        return value.flatMap((item) => programValueReceipts(item, depth + 1));
    const result = record(value);
    if (!result)
        return [];
    return [
        ...receiptAssets(result),
        ...Object.values(result).flatMap((item) => programValueReceipts(item, depth + 1)),
    ];
}
function programTextReceipts(text, depth) {
    // Returned paths, lines and names are skipped without parsing.
    if (!text.includes(NODE_ID_KEY))
        return [];
    const output = text.startsWith('<task_output') ? completedTaskOutputText(text) : text;
    // Serialized JSON, such as a saved query result, is searched like a returned value.
    const nested = /^\s*[[{]/u.test(output) ? parseJson(output) : undefined;
    if (nested !== null && typeof nested === 'object')
        return programValueReceipts(nested, depth + 1);
    return receiptTextItems(output);
}
/**
 * A `task_output` read returned by a program carries no details, so its own text must show
 * what a direct read's details prove: the task succeeded, the read was not truncated, and the
 * command exited with code 0. Anything else, including hints between them, is not read.
 */
function completedTaskOutputText(text) {
    const match = /^<task_output status="succeeded">\n<task_output_cursor ([^>]*)\/>\n<bash_status>Command exited with code 0<\/bash_status>\n([\s\S]*)\n<\/task_output>\s*$/u.exec(text);
    const [, cursor = '', body = ''] = match ?? [];
    return /(?:^|\s)truncated="false"(?:\s|$)/u.test(cursor) ? body : '';
}
function parseJson(text) {
    try {
        return JSON.parse(text);
    }
    catch {
        return undefined;
    }
}
function parseRecord(text) {
    return record(parseJson(text));
}
function receiptAssets(result) {
    const succeeded = result.code === 0 || result.code === '0';
    if (succeeded && Array.isArray(result.success_items))
        return result.success_items;
    // A completed video generation query reports its single asset at the top level.
    if ((succeeded || result.code === undefined) && result.status === 'succeeded')
        return [result];
    return [];
}
function imageNode(value) {
    const asset = record(value);
    if (typeof asset?.node_id !== 'string' ||
        !/^\d{1,32}$/u.test(asset.node_id) ||
        typeof asset.file_name !== 'string')
        return undefined;
    const kind = deriveMediaKind({ path: asset.file_name });
    if (kind !== 'image' && kind !== 'video')
        return undefined;
    const taskId = kind === 'video' && typeof asset.task_id === 'string' && /^\d{1,32}$/u.test(asset.task_id)
        ? asset.task_id
        : undefined;
    return {
        nodeId: asset.node_id,
        kind,
        fileName: fileBasename(asset.file_name),
        ...(taskId ? { taskId } : {}),
    };
}
/** A generated video file named after its own provider task, e.g. `<taskId>.mp4`. */
function isTaskFileName({ fileName, taskId }) {
    return Boolean(taskId) && fileName.slice(0, fileName.lastIndexOf('.')) === taskId;
}
function generationResultText(message, text) {
    if (message.toolName !== 'task_output')
        return text;
    const details = record(message.details);
    const execution = record(details?.execution);
    if (details?.status !== 'succeeded' ||
        details.truncated !== false ||
        execution?.status !== 'succeeded' ||
        execution.exitCode !== 0)
        return '';
    // task_output wraps the successful background process's stdout in transport tags.
    // Strip only that known envelope; arbitrary prose and incomplete output remain invalid JSON.
    const body = /^<task_output status="succeeded">\s*([\s\S]*)\s*<\/task_output>\s*$/u.exec(text)?.[1];
    return (body
        ?.replace(/^<task_output_cursor\s[^>]*\/\s*>\s*/u, '')
        .replace(/^<bash_status>[^<]*<\/bash_status>\s*/u, '') ?? '');
}
function record(value) {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value
        : undefined;
}
//# sourceMappingURL=service.js.map