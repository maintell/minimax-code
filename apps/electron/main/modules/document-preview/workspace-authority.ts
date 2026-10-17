import { randomBytes } from "node:crypto";
import { realpath, lstat, stat } from "node:fs/promises";
import path from "node:path";
const DELIVERED_FILE_PAGE_SIZE = 100;
const MAX_DELIVERED_FILE_PAGES = 10;
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
            info.mtimeMs.toString() === expected.mtimeMs);
    }
    catch {
        return false;
    }
}
/** Only the runtime's persisted session deliverables can authorize an external path. */
export async function isSessionDeliveredFileFromRuntime(sessionId, absolutePath) {
    if (!validSessionId(sessionId) || !path.isAbsolute(absolutePath))
        return false;
    try {
        const { handleLocalRuntimeRequest } = await import('../local-runtime');
        const seen = new Set();
        let cursor;
        // Bound historical index IO. Failure or an exhausted budget never grants a directory.
        for (let page = 0; page < MAX_DELIVERED_FILE_PAGES; page += 1) {
            const url = new URL(`http://127.0.0.1/minimax-desktop/api/v1/session/${encodeURIComponent(sessionId)}/files`);
            url.searchParams.set('limit', String(DELIVERED_FILE_PAGE_SIZE));
            if (cursor)
                url.searchParams.set('cursor', cursor);
            const response = await handleLocalRuntimeRequest(new Request(url, { method: 'GET' }));
            if (!response.ok)
                return false;
            const body = await response.json();
            if (!body || typeof body !== 'object' || Array.isArray(body))
                return false;
            const result = body;
            if (!Array.isArray(result.nodes) || result.nodes.length > DELIVERED_FILE_PAGE_SIZE)
                return false;
            if (result.nodes.some((node) => {
                if (!node || typeof node !== 'object' || Array.isArray(node))
                    return false;
                const file = node;
                return ((file.sessionId ?? file.session_id) === sessionId &&
                    !(file.nodeId ?? file.node_id) &&
                    typeof file.path === 'string' &&
                    path.isAbsolute(file.path) &&
                    path.resolve(file.path) === absolutePath);
            }))
                return true;
            const next = result.nextCursor ?? result.next_cursor;
            if (!(result.hasMore ?? result.has_more) ||
                typeof next !== 'string' ||
                !next ||
                next.length > 4096 ||
                seen.has(next))
                return false;
            seen.add(next);
            cursor = next;
        }
    }
    catch {
        return false;
    }
    return false;
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
    const isSessionDeliveredFile = options.isSessionDeliveredFile ?? isSessionDeliveredFileFromRuntime;
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
    const commit = (ticket, workspaceDir, sessionId, canonical) => {
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
        };
        return canonical.canonicalPath;
    };
    const resolveTrustedWorkspace = async ({ senderId, claimedWorkspaceDir, claimedFilePath, sessionId, }) => {
        if (!validSenderId(senderId))
            return null;
        const ticket = begin(senderId);
        const claimed = await canonicalDirectory(claimedWorkspaceDir);
        if (!claimed || !current(ticket))
            return null;
        const defaultWorkspace = await canonicalDirectory(await resolveDefaultWorkspaceDir());
        if (!validSessionId(sessionId) && defaultWorkspace?.canonicalPath === claimed.canonicalPath) {
            return commit(ticket, claimed.canonicalPath, undefined, claimed);
        }
        // Every non-default root requires a fresh authoritative session lookup.
        // In particular, a missing/revoked session never falls back to the last
        // sender binding.
        if (!validSessionId(sessionId))
            return null;
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
        if (!authoritative || !current(ticket))
            return null;
        if (authoritative.canonicalPath !== claimed.canonicalPath) {
            // The renderer historically rebases external delivered files to parent + basename.
            // Prove that exact file belongs to this session instead of trusting the rebased root.
            if (typeof claimedFilePath !== 'string' ||
                !claimedFilePath ||
                claimedFilePath.length > 256 ||
                /[\\/\u0000-\u001f\u007f-\u009f]/u.test(claimedFilePath) ||
                claimedFilePath === '.' ||
                claimedFilePath === '..' ||
                path.extname(claimedFilePath).toLowerCase() !== '.pptx')
                return null;
            const requestedPath = path.resolve(claimedWorkspaceDir, claimedFilePath);
            if (!(await isSessionDeliveredFile(sessionId, requestedPath)) || !current(ticket))
                return null;
            const canonicalPath = path.join(claimed.canonicalPath, claimedFilePath);
            try {
                const info = await lstat(canonicalPath, { bigint: true });
                if (!info.isFile() || info.isSymbolicLink())
                    return null;
                return commit(ticket, claimed.canonicalPath, sessionId, {
                    ...claimed,
                    file: {
                        canonicalPath,
                        dev: info.dev.toString(),
                        ino: info.ino.toString(),
                        size: info.size.toString(),
                        mtimeMs: info.mtimeMs.toString(),
                    },
                });
            }
            catch {
                return null;
            }
        }
        return commit(ticket, authoritative.canonicalPath, sessionId, authoritative);
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
                    state.binding.capability.file.canonicalPath))
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
