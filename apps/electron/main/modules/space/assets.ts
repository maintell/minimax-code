/**
 * Manual upload of a session file to Space from the Desktop file panel
 * (`window.mcodeToolsAssetsAPI`). It runs the Space core the agent's space_upload tool uses,
 * in Electron main, signed in with the shared Desktop OAuth session. The IPC channel and
 * renderer API keep their historical `mcodeTools` names because the renderer contract is
 * unchanged.
 */
import { randomBytes } from "node:crypto";
import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { assertSameLoginEpoch } from "@mavis/oauth-core";
import { importEsm } from "../../utils/import-esm";
import logger from "../../utils/logger";
import { currentManagedRoutingHeaders } from "../local-runtime";
/** One overall deadline per request; large uploads can legitimately take minutes. */
export let SPACE_ASSETS_TIMEOUT_MS = 10 * 60 * 1000;
const ACCESS_TOKEN_MIN_VALIDITY_MS = 30000;
const ABSOLUTE_LOCAL_PATH = /^(\/|[a-zA-Z]:[\\/]|\\\\)/u;
/** Manual uploads belong to no agent session; delete confirmations are never used here. */
const MANUAL_UPLOAD_SESSION_ID = 'desktop-manual-upload';
/** The Desktop session could not provide a usable access token. */
class SignedOutError extends Error {
}
/** A Space node that cannot be staged for a read-only preview. */
class PreviewRejectedError extends Error {
    constructor(code) {
        super(code);
        this.code = code;
    }
}
let defaultModules;
function loadDefaultModules() {
    if (!defaultModules) {
        defaultModules = Promise.all([
            importEsm('@mavis/agent-tools/space'),
            importEsm('@mavis/agent-tools/desktop/matrix-client'),
            importEsm('@mavis/agent-tools/desktop/space-drive-backend'),
        ]).then(([space, client, backend]) => ({
            space,
            DesktopMatrixClient: client.DesktopMatrixClient,
            DesktopSpaceDriveBackend: backend.DesktopSpaceDriveBackend,
        }));
        defaultModules.catch(() => {
            defaultModules = undefined;
        });
    }
    return defaultModules;
}
export async function getSpaceAssetsStatus(deps) {
    try {
        await (deps.loadModules ?? loadDefaultModules)();
        return { available: true };
    }
    catch (error) {
        logger.warn(`[space] manual upload unavailable: ${errorName(error)}`);
        return { available: false };
    }
}
export async function uploadSpaceAsset(input, deps) {
    if (!ABSOLUTE_LOCAL_PATH.test(input.localPath)) {
        return failure('INVALID_ARGUMENT', 'Local path must be absolute');
    }
    if (input.to !== undefined && !input.to.startsWith('/')) {
        return failure('INVALID_ARGUMENT', 'Space folder must start with /');
    }
    try {
        if (!(await stat(input.localPath)).isFile()) {
            return failure('LOCAL_FILE_NOT_FOUND', 'Local file not found');
        }
    }
    catch {
        return failure('LOCAL_FILE_NOT_FOUND', 'Local file not found');
    }
    const args = {
        local_path: input.localPath,
        ...(input.to === undefined ? {} : { to_folder: input.to }),
        ...(input.id === undefined ? {} : { node_id: input.id }),
        ...(input.onConflict === undefined ? {} : { on_conflict: input.onConflict }),
    };
    return runSpace('upload', deps, async (modules, ctx) => {
        const output = await modules.space.uploadSpace(ctx, args);
        return {
            node: toAssetNode(output.node),
            overwritten: output.overwritten,
            source_path: output.source_path,
            sha256: output.sha256,
        };
    });
}
export async function statSpaceAsset(input, deps) {
    if (!input.path.startsWith('/')) {
        return failure('INVALID_ARGUMENT', 'Space path must start with /');
    }
    return runSpace('stat', deps, async (modules, ctx) => {
        const output = await modules.space.statSpace(ctx, { space_path: input.path });
        return { node: toAssetNode(output.node) };
    });
}
/**
 * Download one Space file into `directory` for a read-only preview. Main resolves the node
 * itself, so the renderer submits only the node id, never bytes or a path.
 */
export async function downloadSpacePreviewFile(input, deps) {
    return runSpace('preview', deps, async (modules, ctx) => {
        let url;
        let fileName;
        if (modules.space.isLegacyNodeId(input.nodeId)) {
            // Classic library items have no drive route: their signed URL comes from the library
            // and their name from that URL, as there is no listing to read it from.
            const library = ctx.drive;
            if (typeof library.getLibraryDownloadUrl !== 'function') {
                throw new PreviewRejectedError('LEGACY_ITEM');
            }
            url = await library.getLibraryDownloadUrl(input.nodeId.slice('cs_'.length), ctx.signal);
            fileName = classicPreviewFileName(url, input.extensions);
            if (!fileName)
                throw new PreviewRejectedError('UNSUPPORTED_FILE');
        }
        else {
            const { node } = await ctx.drive.getFile(input.nodeId, ctx.signal);
            fileName = previewFileName(node.name, input.extensions);
            if (node.node_type !== modules.space.DRIVE_NODE_TYPE_FILE || !fileName) {
                throw new PreviewRejectedError('UNSUPPORTED_FILE');
            }
            if (node.size_bytes > input.maxBytes)
                throw new PreviewRejectedError('TOO_LARGE');
            url = await ctx.drive.getDownloadUrl(node.node_id, ctx.signal);
        }
        // The listed size can be stale (classic items have none), so the cap is also enforced
        // while the body streams.
        const limited = limitDownloadBytes(ctx.fetchImpl, input.maxBytes);
        let saved;
        try {
            saved = await modules.space.downloadToFile(url, join(input.directory, fileName), limited.fetchImpl, ctx.signal);
        }
        catch (error) {
            if (limited.exceeded())
                throw new PreviewRejectedError('TOO_LARGE');
            throw error;
        }
        return { fileName, bytes: saved.bytes };
    }, input.signal);
}
/**
 * Wrap `fetchImpl` so a download stops as soon as it is known to exceed `maxBytes`: up front
 * from Content-Length, otherwise once the streamed body passes the cap. Erroring the body
 * cancels the upstream response, so nothing past the cap is downloaded or written.
 */
export function limitDownloadBytes(fetchImpl, maxBytes) {
    let exceeded = false;
    const tooLarge = () => {
        exceeded = true;
        return new Error('Space preview download exceeds the size limit');
    };
    const limited = async (resource, init) => {
        const response = await fetchImpl(resource, init);
        if (!response.ok || !response.body)
            return response;
        const declared = Number(response.headers.get('content-length') ?? '');
        if (Number.isFinite(declared) && declared > maxBytes) {
            await response.body.cancel().catch(() => undefined);
            throw tooLarge();
        }
        let received = 0;
        const body = response.body.pipeThrough(new TransformStream({
            transform(chunk, controller) {
                received += chunk.byteLength;
                if (received > maxBytes)
                    controller.error(tooLarge());
                else
                    controller.enqueue(chunk);
            },
        }));
        return new Response(body, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
        });
    };
    return { fetchImpl: limited, exceeded: () => exceeded };
}
/**
 * Local name of a classic copy: the URL's last segment when it carries an accepted extension,
 * otherwise `preview.<ext>`. A signed URL's last segment is not a reliable file name (opaque
 * routes, dotted tokens), and the renderer only claims items it already knows are
 * presentations; PPTX Core rejects bytes that are not one.
 */
function classicPreviewFileName(url, extensions) {
    let segment = '';
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
            return null;
        segment = decodeURIComponent(parsed.pathname.split('/').pop() ?? '').trim();
    }
    catch {
        return null;
    }
    const fallback = extensions[0];
    return previewFileName(segment, extensions) ?? (fallback ? `preview.${fallback}` : null);
}
/** A single safe path segment that keeps the accepted extension, or null. */
function previewFileName(name, extensions) {
    const base = name
        .split(/[\\/]/u)
        .pop()
        ?.replace(/[\u0000-\u001f\u007f]/gu, '')
        .trim() ?? '';
    const extension = base.includes('.') ? base.split('.').pop()?.toLowerCase() : undefined;
    if (!extension || !extensions.includes(extension))
        return null;
    // Space names come from any platform; keep the local copy writable on Windows too.
    const safe = base.replace(/[<>:"|?*]/gu, '_');
    const stem = safe.split('.')[0]?.trim() ?? '';
    if (safe === `.${extension}` || safe.length > 200 || WINDOWS_RESERVED_NAME.test(stem)) {
        return `preview.${extension}`;
    }
    return safe;
}
/** Device names Windows will not create as files, whatever the extension. */
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu;
async function runSpace(operation, deps, run, signal) {
    let modules;
    try {
        modules = await (deps.loadModules ?? loadDefaultModules)();
    }
    catch (error) {
        logger.warn(`[space] ${operation} unavailable: ${errorName(error)}`);
        return failure('UNAVAILABLE', 'Space is not available');
    }
    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? SPACE_ASSETS_TIMEOUT_MS);
    const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    try {
        if (signal?.aborted)
            throw new PreviewRejectedError('CANCELLED');
        const output = await withAccessToken(deps, modules, (accessToken) => run(modules, buildContext(modules, deps, accessToken, requestSignal)));
        logger.info(`[space] ${operation} ok durationMs=${Date.now() - startedAt}`);
        return { ok: true, output };
    }
    catch (error) {
        const result = controller.signal.aborted
            ? failure('TIMEOUT', 'Space request timed out')
            : toFailure(modules, error);
        // Messages may name local or Space paths; only the code and timing are logged.
        logger.warn(`[space] ${operation} failed code=${result.code} durationMs=${Date.now() - startedAt}`);
        return result;
    }
    finally {
        clearTimeout(timer);
    }
}
/** Run once; on UNAUTHORIZED let the shared session refresh and run once more. */
async function withAccessToken(deps, modules, run) {
    let lease = await leaseAccessToken(deps);
    try {
        return await run(lease.accessToken);
    }
    catch (error) {
        if (!isUnauthorized(modules, error))
            throw error;
        const decision = await deps.session.handleUnauthorized(lease.generation, lease.loginEpoch);
        if (decision !== 'retry') {
            if (decision === 'logout')
                await invalidateAccessToken(deps);
            throw error;
        }
    }
    const requestEpoch = lease.loginEpoch;
    lease = await leaseAccessToken(deps);
    try {
        assertSameLoginEpoch(requestEpoch, lease.loginEpoch);
    }
    catch (error) {
        throw new SignedOutError(errorName(error));
    }
    try {
        return await run(lease.accessToken);
    }
    catch (error) {
        if (isUnauthorized(modules, error) &&
            (await deps.session.handleUnauthorized(lease.generation, lease.loginEpoch)) === 'logout') {
            await invalidateAccessToken(deps);
        }
        throw error;
    }
}
async function leaseAccessToken(deps) {
    try {
        return await deps.session.getAccessToken(ACCESS_TOKEN_MIN_VALIDITY_MS);
    }
    catch (error) {
        throw new SignedOutError(errorName(error));
    }
}
async function invalidateAccessToken(deps) {
    try {
        await deps.onAccessTokenInvalidated?.();
    }
    catch {
        // The upload result is reported either way.
    }
}
function buildContext(modules, deps, accessToken, signal) {
    const routingHeaders = deps.routingHeaders ?? currentManagedRoutingHeaders;
    // Same endpoint resolution as the agent's space_* tools: the managed gateway of this build.
    const client = new modules.DesktopMatrixClient({
        authContext: { accessToken },
        routingHeadersGetter: () => routingHeaders() ?? {},
    });
    return {
        drive: new modules.DesktopSpaceDriveBackend(client),
        sessionId: MANUAL_UPLOAD_SESSION_ID,
        fetchImpl: globalThis.fetch,
        resolveLocalPath: async (path) => resolve(path),
        // Manual uploads read the Desktop's own disk, as the agent's space_upload does here.
        localFiles: modules.space.nodeFsSpaceLocalFileAccess,
        confirmations: new modules.space.SpaceDeleteConfirmations(),
        now: Date.now,
        randomToken: () => randomBytes(6).toString('hex'),
        signal,
    };
}
function isUnauthorized(modules, error) {
    return (!(error instanceof SignedOutError) &&
        !(error instanceof PreviewRejectedError) &&
        modules.space.toSpaceError(error).code === 'UNAUTHORIZED');
}
function toFailure(modules, error) {
    if (error instanceof PreviewRejectedError) {
        return failure(error.code, 'Space file cannot be previewed');
    }
    if (error instanceof SignedOutError) {
        return failure('UNAUTHORIZED', 'Sign in to upload to Space');
    }
    const spaceError = modules.space.toSpaceError(error);
    return failure(spaceError.code, spaceError.message);
}
/**
 * The renderer contract predates the Space core: `path` is required (empty when unknown).
 * `updated_at` is optional there and unused by the renderer, so it is left out.
 */
function toAssetNode(node) {
    return {
        node_id: node.node_id,
        path: node.path ?? '',
        name: node.name,
        type: node.type,
        ...(node.size_bytes === undefined ? {} : { size_bytes: node.size_bytes }),
    };
}
function errorName(error) {
    return error instanceof Error ? error.name : typeof error;
}
function failure(code, message) {
    return { ok: false, code, message };
}
