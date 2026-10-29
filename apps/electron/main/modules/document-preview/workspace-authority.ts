import { randomBytes } from "node:crypto";
import { realpathSync, lstatSync } from "node:fs";
import { realpath, lstat, stat } from "node:fs/promises";
import path from "node:path";
const DELIVERED_FILE_PAGE_SIZE = 100;
const MAX_DELIVERED_FILE_PAGES = 10;
const MAX_DELIVERED_IDENTITY_PROBES = 16;
const issuedCapabilities = new WeakSet();
export function isTrustedWorkspaceCapability(value) {
    return (Boolean(value) &&
        typeof value === 'object' &&
        issuedCapabilities.has(value) &&
        typeof value.canonicalPath === 'string' &&
        typeof value.identity?.dev === 'string' &&
        typeof value.identity?.ino === 'string');
}
function validSessionId(value) {
    return (typeof value === 'string' &&
        value.length > 0 &&
        value.length <= 256 &&
        !/[\u0000-\u001f\u007f-\u009f]/u.test(value));
}
function validSenderId(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
async function canonicalDirectory(value) {
    if (!value || value.length > 4096 || /[\u0000-\u001f\u007f-\u009f]/u.test(value))
        return null;
    try {
        const canonicalPath = await realpath(value);
        const info = await lstat(canonicalPath, { bigint: true });
        if (!info.isDirectory() || info.isSymbolicLink())
            return null;
        return {
            canonicalPath,
            identity: { dev: info.dev.toString(), ino: info.ino.toString() },
        };
    }
    catch {
        return null;
    }
}
function issueCapability(canonical) {
    const capability = Object.freeze({
        canonicalPath: canonical.canonicalPath,
        identity: { ...canonical.identity },
        nonce: randomBytes(24).toString('base64url'),
        ...(canonical.file ? { file: Object.freeze({ ...canonical.file }) } : {}),
    });
    issuedCapabilities.add(capability);
    return capability;
}
/**
 * Create a capability for an already-authorized main path.  This is used by
 * the IPC adapter when a host injects a string-only resolver; production's
 * authority uses the companion lookup below so the identity is captured in
 * the same sender binding as the authoritative session result.
 */
export async function issueTrustedWorkspaceCapability(workspaceDir) {
    const canonical = await canonicalDirectory(workspaceDir);
    return canonical ? issueCapability(canonical) : null;
}
/** Main-only exact-file grant for an OS selection; never call with renderer paths. */
export function issueSelectedFileCapability(filePath) {
    try {
        if (!path.isAbsolute(filePath))
            return null;
        const canonicalPath = realpathSync(filePath);
        const info = lstatSync(canonicalPath, { bigint: true });
        if (!info.isFile() || info.isSymbolicLink() || info.ino === 0n)
            return null;
        const root = path.dirname(canonicalPath);
        const rootInfo = lstatSync(root, { bigint: true });
        if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
            return null;
        return issueCapability({
            canonicalPath: root,
            identity: { dev: rootInfo.dev.toString(), ino: rootInfo.ino.toString() },
            file: {
                canonicalPath,
                dev: info.dev.toString(),
                ino: info.ino.toString(),
                size: info.size.toString(),
                mtimeMs: info.mtimeMs.toString(),
                ctimeMs: info.ctimeMs.toString(),
            },
        });
    }
    catch {
        return null;
    }
}
/** Verify that a capability's root still names the same directory identity. */
export async function verifyTrustedWorkspaceCapability(capability) {
    if (!isTrustedWorkspaceCapability(capability))
        return false;
    try {
        const currentPath = await realpath(capability.canonicalPath);
        if (currentPath !== capability.canonicalPath)
            return false;
        const info = await stat(currentPath, { bigint: true });
        return (info.isDirectory() &&
            info.dev.toString() === capability.identity.dev &&
            info.ino.toString() === capability.identity.ino);
    }
    catch {
        return false;
    }
}
/** Bind an external source to the exact no-follow file identity authorized by main. */
export async function verifyTrustedWorkspaceFile(capability, canonicalPath) {
    if (!isTrustedWorkspaceCapability(capability))
        return false;
    if (!capability.file)
        return true;
    const expected = capability.file;
    if (canonicalPath !== expected.canonicalPath)
        return false;
    try {
        const info = await lstat(canonicalPath, { bigint: true });
        return (info.isFile() &&
            !info.isSymbolicLink() &&
            info.dev.toString() === expected.dev &&
            info.ino.toString() === expected.ino &&
            info.size.toString() === expected.size &&
            info.mtimeMs.toString() === expected.mtimeMs &&
            (expected.ctimeMs === undefined || info.ctimeMs.toString() === expected.ctimeMs));
    }
    catch {
        return false;
    }
}
async function regularFileIdentity(filePath) {
    try {
        const info = await lstat(filePath, { bigint: true });
        // Some network filesystems report no inode; a zero identity proves nothing.
        if (!info.isFile() || info.isSymbolicLink() || info.ino === 0n)
            return null;
        return `${info.dev}:${info.ino}`;
    }
    catch {
        return null;
    }
}
/**
 * Only the runtime's persisted session deliverables can authorize an external path.
 * A recorded path whose spelling differs from the claim (Windows drive/name case,
 * separators) is accepted only when both name the same regular file.
 */
export async function lookupSessionDeliveredFileFromRuntime(sessionId, absolutePath) {
    if (!validSessionId(sessionId) || !path.isAbsolute(absolutePath))
        return 'lookup_failed';
    const requestedName = path.basename(absolutePath).toLowerCase();
    const identityCandidates = [];
    let nodeIdPresent = false;
    try {
        const { handleLocalRuntimeRequest } = await import('../local-runtime');
        const seen = new Set();
        let cursor;
        let complete = false;
        // Bound historical index IO. Failure or an exhausted budget never grants a directory.
        for (let page = 0; page < MAX_DELIVERED_FILE_PAGES && !complete; page += 1) {
            const url = new URL(`http://127.0.0.1/minimax-desktop/api/v1/session/${encodeURIComponent(sessionId)}/files`);
            url.searchParams.set('limit', String(DELIVERED_FILE_PAGE_SIZE));
            if (cursor)
                url.searchParams.set('cursor', cursor);
            const response = await handleLocalRuntimeRequest(new Request(url, { method: 'GET' }));
            if (!response.ok)
                return 'lookup_failed';
            const body = await response.json();
            if (!body || typeof body !== 'object' || Array.isArray(body))
                return 'lookup_failed';
            const result = body;
            if (!Array.isArray(result.nodes) || result.nodes.length > DELIVERED_FILE_PAGE_SIZE)
                return 'lookup_failed';
            for (const node of result.nodes) {
                if (!node || typeof node !== 'object' || Array.isArray(node))
                    continue;
                const file = node;
                if ((file.sessionId ?? file.session_id) !== sessionId ||
                    typeof file.path !== 'string' ||
                    !path.isAbsolute(file.path))
                    continue;
                const recordedPath = path.resolve(file.path);
                const sameName = path.basename(recordedPath).toLowerCase() === requestedName;
                if (file.nodeId ?? file.node_id) {
                    if (sameName)
                        nodeIdPresent = true;
                    continue;
                }
                if (recordedPath === absolutePath)
                    return 'exact';
                if (sameName && !identityCandidates.includes(recordedPath))
                    identityCandidates.push(recordedPath);
            }
            const next = result.nextCursor ?? result.next_cursor;
            if (!(result.hasMore ?? result.has_more)) {
                complete = true;
                continue;
            }
            if (typeof next !== 'string' || !next || next.length > 4096 || seen.has(next))
                return 'lookup_failed';
            seen.add(next);
            cursor = next;
        }
        if (identityCandidates.length > 0) {
            const requestedIdentity = await regularFileIdentity(absolutePath);
            if (requestedIdentity) {
                for (const candidate of identityCandidates.slice(0, MAX_DELIVERED_IDENTITY_PROBES)) {
                    if ((await regularFileIdentity(candidate)) === requestedIdentity)
                        return { identity: requestedIdentity };
                }
            }
        }
        if (nodeIdPresent)
            return 'node_id_present';
        return complete ? 'not_found' : 'budget_exhausted';
    }
    catch {
        return 'lookup_failed';
    }
}
export async function isSessionDeliveredFileFromRuntime(sessionId, absolutePath) {
    const lookup = await lookupSessionDeliveredFileFromRuntime(sessionId, absolutePath);
    return lookup === 'exact' || typeof lookup === 'object';
}
export async function fetchSessionWorkspaceFromRuntime(sessionId) {
    try {
        const { handleLocalRuntimeRequest } = await import('../local-runtime');
        const response = await handleLocalRuntimeRequest(new Request(`http://127.0.0.1/minimax-desktop/api/v1/session/${encodeURIComponent(sessionId)}`, {
            method: 'GET',
        }));
        if (!response.ok)
            return null;
        const body = await response.json();
        if (!body || typeof body !== 'object' || Array.isArray(body))
            return null;
        const session = body.session;
        if (!session || typeof session !== 'object' || Array.isArray(session))
            return null;
        const record = session;
        const workspace = record.workspaceDir ?? record.workspace_dir;
        return typeof workspace === 'string' && workspace.length > 0 ? workspace : null;
    }
    catch {
        // Runtime startup/teardown is expected to race with preview requests. A
        // failed authoritative lookup must fail closed, never fall back to the
        // renderer claim or a previous sender binding.
        return null;
    }
}
/**
 * Build the production workspace authority for document-preview IPC.
 *
 * A renderer may provide a session id and a workspace claim, but only the
 * workspace returned by the main-owned local-runtime session endpoint is
 * accepted. Both values are canonicalized with `realpath` before comparison.
 * Non-default roots require a fresh session lookup on every request: a sender
 * binding is never used as a sticky fallback. Per-sender epoch/sequence
 * tickets make teardown and out-of-order A/B lookups fail closed.
 */
export function createMainOwnedWorkspaceAuthority(options = {}) {
    const fetchSessionWorkspace = options.fetchSessionWorkspace ?? fetchSessionWorkspaceFromRuntime;
    const isSessionDeliveredFile = options.isSessionDeliveredFile ?? lookupSessionDeliveredFileFromRuntime;
    const defaultWorkspaceDir = options.defaultWorkspaceDir;
    let defaultWorkspacePromise = null;
    const resolveDefaultWorkspaceDir = () => {
        if (defaultWorkspaceDir)
            return Promise.resolve(defaultWorkspaceDir);
        if (!defaultWorkspacePromise) {
            defaultWorkspacePromise = import('../local-runtime/data-dir').then(({ resolveLocalRuntimeDataDir }) => path.join(resolveLocalRuntimeDataDir(), 'workspace'));
        }
        return defaultWorkspacePromise;
    };
    const senderStates = new Map();
    const stateFor = (senderId) => {
        let state = senderStates.get(senderId);
        if (!state) {
            state = { epoch: 0, sequence: 0, alive: true };
            senderStates.set(senderId, state);
        }
        else if (!state.alive) {
            // A new WebContents may receive a recycled numeric id. Start a fresh
            // epoch so a lookup from the destroyed instance cannot commit into it.
            state.epoch += 1;
            state.sequence = 0;
            state.alive = true;
            state.binding = undefined;
        }
        return state;
    };
    const begin = (senderId) => {
        const state = stateFor(senderId);
        state.sequence += 1;
        // Any new lookup supersedes the previous root. This prevents a revoked or
        // stale binding from being used while the fresh authoritative lookup is
        // awaiting the runtime.
        state.binding = undefined;
        return { senderId, epoch: state.epoch, sequence: state.sequence };
    };
    const current = (ticket) => {
        const state = senderStates.get(ticket.senderId);
        return Boolean(state && state.alive && state.epoch === ticket.epoch && state.sequence === ticket.sequence);
    };
    const commit = (ticket, workspaceDir, sessionId, canonical, fileClaimPath) => {
        if (!current(ticket))
            return null;
        const state = senderStates.get(ticket.senderId);
        if (!state)
            return null;
        const capability = issueCapability(canonical);
        state.binding = {
            epoch: ticket.epoch,
            sequence: ticket.sequence,
            sessionId,
            workspaceDir,
            capability,
            ...(fileClaimPath ? { fileClaimPath } : {}),
        };
        return canonical.canonicalPath;
    };
    const deliveredDenial = {
        not_found: 'deliverable_not_found',
        node_id_present: 'deliverable_node_id_present',
        lookup_failed: 'deliverable_lookup_failed',
        budget_exhausted: 'deliverable_lookup_budget_exhausted',
    };
    const resolveTrustedWorkspace = async ({ senderId, claimedWorkspaceDir, claimedFilePath, sessionId, onDenied, }) => {
        const deny = (detail) => {
            try {
                onDenied?.(detail);
            }
            catch {
                // Observability must never change the authorization result.
            }
            return null;
        };
        if (!validSenderId(senderId))
            return deny('invalid_sender');
        const ticket = begin(senderId);
        const claimed = await canonicalDirectory(claimedWorkspaceDir);
        if (!current(ticket))
            return deny('stale_request');
        if (!claimed)
            return deny('claimed_dir_unavailable');
        const defaultWorkspace = await canonicalDirectory(await resolveDefaultWorkspaceDir());
        if (!validSessionId(sessionId) && defaultWorkspace?.canonicalPath === claimed.canonicalPath) {
            return commit(ticket, claimed.canonicalPath, undefined, claimed) ?? deny('stale_request');
        }
        // Every non-default root requires a fresh authoritative session lookup.
        // In particular, a missing/revoked session never falls back to the last
        // sender binding.
        if (!validSessionId(sessionId))
            return deny('no_session');
        let authoritativeWorkspace = null;
        try {
            authoritativeWorkspace = await fetchSessionWorkspace(sessionId);
        }
        catch {
            authoritativeWorkspace = null;
        }
        const authoritative = authoritativeWorkspace
            ? await canonicalDirectory(authoritativeWorkspace)
            : null;
        if (!current(ticket))
            return deny('stale_request');
        if (!authoritativeWorkspace)
            return deny('session_lookup_failed');
        if (!authoritative)
            return deny('session_workspace_unavailable');
        if (authoritative.canonicalPath !== claimed.canonicalPath) {
            // The renderer historically rebases external delivered files to parent + basename.
            // Prove that exact file belongs to this session instead of trusting the rebased root.
            if (typeof claimedFilePath === 'string' &&
                /[\\/]/u.test(claimedFilePath) &&
                !path.isAbsolute(claimedFilePath) &&
                !claimedFilePath.split(/[\\/]/u).includes('..'))
                return deny('deliverable_nested_path');
            if (typeof claimedFilePath !== 'string' ||
                !claimedFilePath ||
                claimedFilePath.length > 256 ||
                /[\\/\u0000-\u001f\u007f-\u009f]/u.test(claimedFilePath) ||
                claimedFilePath === '.' ||
                claimedFilePath === '..' ||
                path.extname(claimedFilePath).toLowerCase() !== '.pptx')
                return deny('deliverable_path_invalid');
            const requestedPath = path.resolve(claimedWorkspaceDir, claimedFilePath);
            const delivered = await isSessionDeliveredFile(sessionId, requestedPath);
            if (!current(ticket))
                return deny('stale_request');
            const lookup = delivered === true ? 'exact' : delivered === false ? 'not_found' : delivered;
            if (lookup !== 'exact' && typeof lookup !== 'object')
                return deny(deliveredDenial[lookup]);
            const fileClaimPath = path.join(claimed.canonicalPath, claimedFilePath);
            try {
                const claimedInfo = await lstat(fileClaimPath, { bigint: true });
                if (!claimedInfo.isFile() || claimedInfo.isSymbolicLink())
                    return deny('deliverable_file_unavailable');
                // An identity grant covers only the file verified against the index,
                // not whatever replaced that spelling afterwards.
                if (typeof lookup === 'object' &&
                    `${claimedInfo.dev}:${claimedInfo.ino}` !== lookup.identity)
                    return deny('deliverable_identity_changed');
                // The source registry compares against realpath(); a case-folded
                // spelling must be bound to the on-disk name it will see.
                const canonicalPath = await realpath(fileClaimPath);
                if (path.dirname(canonicalPath) !== claimed.canonicalPath)
                    return deny('deliverable_file_unavailable');
                const info = await lstat(canonicalPath, { bigint: true });
                if (!info.isFile() ||
                    info.isSymbolicLink() ||
                    info.dev !== claimedInfo.dev ||
                    info.ino !== claimedInfo.ino)
                    return deny('deliverable_file_unavailable');
                if (!current(ticket))
                    return deny('stale_request');
                return (commit(ticket, claimed.canonicalPath, sessionId, {
                    ...claimed,
                    file: {
                        canonicalPath,
                        dev: info.dev.toString(),
                        ino: info.ino.toString(),
                        size: info.size.toString(),
                        mtimeMs: info.mtimeMs.toString(),
                    },
                }, fileClaimPath) ?? deny('stale_request'));
            }
            catch {
                return deny('deliverable_file_unavailable');
            }
        }
        return (commit(ticket, authoritative.canonicalPath, sessionId, authoritative) ?? deny('stale_request'));
    };
    const resolveTrustedWorkspaceCapability = async ({ senderId, claimedWorkspaceDir, sessionId, claimedFilePath, }) => {
        if (!validSenderId(senderId))
            return null;
        const state = senderStates.get(senderId);
        if (!state?.alive || !state.binding)
            return null;
        const claimed = await canonicalDirectory(claimedWorkspaceDir);
        if (!claimed || claimed.canonicalPath !== state.binding.workspaceDir)
            return null;
        if (state.binding.sessionId !== undefined && sessionId !== state.binding.sessionId)
            return null;
        if (state.binding.capability.file &&
            (!claimedFilePath ||
                path.join(claimed.canonicalPath, claimedFilePath) !==
                    (state.binding.fileClaimPath ?? state.binding.capability.file.canonicalPath)))
            return null;
        return state.binding.capability;
    };
    return {
        resolveTrustedWorkspace,
        resolveTrustedWorkspaceCapability,
        releaseSender: (senderId) => {
            if (!validSenderId(senderId))
                return;
            const state = senderStates.get(senderId);
            if (!state)
                return;
            state.epoch += 1;
            state.sequence += 1;
            state.alive = false;
            state.binding = undefined;
        },
    };
}
