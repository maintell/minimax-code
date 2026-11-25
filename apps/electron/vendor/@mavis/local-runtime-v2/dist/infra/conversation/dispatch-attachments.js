import { stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { maxLocalAssetBytes } from '../file/assets-store.js';
import { isSensitiveSearchRoot } from '@mavis/agent-tools/desktop';
/**
 * What one dispatch may hand over.
 *
 * The paths are model-chosen, so without a cap a single call can name thousands of files and
 * turn a dispatch into a bulk copy of the machine — the assigner only ever sees "the task
 * started". The numbers are generous enough that no realistic hand-over hits them.
 */
const DISPATCH_ATTACHMENT_LIMITS = {
    /** How many paths one dispatch may name. */
    count: 64,
    /**
     * How large all of one dispatch's files may add up to. The per-file limit is not here: it is
     * whatever the receiving asset registration accepts (`maxLocalAssetBytes`), because that is
     * what actually decides, and a second copy of it here would drift.
     */
    totalBytes: 256 * 1024 * 1024,
};
/** The model filled `attachments` itself: the whole policy applies. */
const MODEL_NAMED_ATTACHMENT_POLICY = {
    secrets: true,
    limits: true,
};
/** The user attached these in their own Turn, or they are being re-checked at queue start. */
const INHERITED_ATTACHMENT_POLICY = {
    secrets: false,
    limits: false,
};
/**
 * Media types a dispatched attachment is classified by, from its extension.
 * Anything else travels as an opaque byte stream; the receiving turn still
 * infers an image from the file name when it needs one.
 */
const DISPATCH_MIME_TYPES = {
    '.bmp': 'image/bmp',
    '.csv': 'text/csv',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.gif': 'image/gif',
    '.heic': 'image/heic',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.json': 'application/json',
    '.log': 'text/plain',
    '.md': 'text/markdown',
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.svg': 'image/svg+xml',
    '.txt': 'text/plain',
    '.webp': 'image/webp',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.zip': 'application/zip',
};
/**
 * The attachments one Session hands to another, built from the local paths the
 * sender named. Naming nothing, or naming only blank paths, yields no
 * attachments: a dispatched task without attachments is the ordinary case, not a
 * failure.
 *
 * Only `filePath` crosses the Session boundary — `assetId`, `dataUrl` and
 * `desktopPath` are all deliberately dropped.
 *
 * `assetId` in particular must never be carried. Registration treats an
 * `assetId` whose path already resolves to a registered v2 asset as "this asset
 * is already ours" and hands the attachment back untouched, skipping the copy
 * branch entirely; asset reads are filtered by owning Session, so an attachment
 * carrying the sender's `assetId` leaves the receiver pointing at an asset it can
 * never read. A bare path always takes the copy branch and gives the receiver an
 * asset of its own, which is the only shape that works across Sessions.
 *
 * Naming the same path twice yields one attachment: the same file twice in one
 * message is a duplicate, not a second copy.
 */
export function dispatchAttachments(paths) {
    const seen = new Set();
    const attachments = [];
    for (const raw of paths ?? []) {
        const filePath = typeof raw === 'string' ? raw.trim() : '';
        if (!filePath || seen.has(filePath))
            continue;
        seen.add(filePath);
        const mimeType = DISPATCH_MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
        attachments.push({
            type: mimeType.startsWith('image/') ? 'image' : 'file',
            filePath,
            fileName: basename(filePath),
            mimeType,
        });
    }
    return attachments;
}
/**
 * Everything wrong with the paths one dispatch named, in the order they were named, so the
 * sender learns what to fix before anything is created on disk.
 *
 * Readability alone was the whole check for a long time, and deliberately so: the Session on the
 * receiving end already runs on this machine with `read` and `bash`, so refusing to copy a file
 * it could open itself removes no capability. What copying does add is a second copy owned by
 * the receiving Session, and task results travel back out over IM — so the secret-bearing paths
 * the rg tools already refuse to surface (`isSensitiveSearchPath`, the same list desktop grep
 * and glob use) are refused here too, and the volume one dispatch may hand over is capped.
 *
 * Everything else stays allowed on purpose: a file the user attached in this very Turn, or one the
 * assigner produced, is what this channel is for. A file the user attached in an EARLIER Turn is
 * not exempt — the exemption reads the dispatching Turn only — so the tool description says so
 * rather than letting the model discover it by being refused.
 */
/** What is wrong with one path, and how many bytes it contributes to the total. */
async function refuseOnePath(filePath, policy) {
    // isSensitiveSearchRoot, not isSensitiveSearchPath: it checks the literal path AND its
    // realpath, so a symlink with an innocent name pointing into ~/.ssh cannot slip through. grep
    // and glob already refuse that file through the same check.
    if (policy.secrets && (await isSensitiveSearchRoot(filePath)))
        return { refusal: { kind: 'sensitive', filePath }, bytes: 0 };
    let info;
    try {
        info = await stat(filePath);
    }
    catch {
        return { refusal: { kind: 'unreadable', filePath }, bytes: 0 };
    }
    if (!info.isFile())
        return { refusal: { kind: 'unreadable', filePath }, bytes: 0 };
    if (!policy.limits)
        return { bytes: 0 };
    // The receiving Session copies this into an asset of its own, so the limit that actually
    // decides is asset registration's — asked, not copied, so the two cannot drift apart.
    const fileBytes = maxLocalAssetBytes(basename(filePath));
    return {
        ...(info.size > fileBytes
            ? { refusal: { kind: 'too-large', filePath, bytes: info.size, limit: fileBytes } }
            : {}),
        bytes: info.size,
    };
}
/**
 * The files the user attached in one Turn, as a set the refusal check can consult.
 *
 * Whether a path was model-chosen is not "did the caller fill the parameter": `assignment_send`
 * has no auto-inherit, so the model has to name even a file the user attached seconds ago. Those
 * paths are the user's own and only readability applies to them — see `DispatchAttachmentPolicy`.
 * Reading the Turn is best-effort: a Turn that cannot be read exempts nothing.
 */
export async function turnUserAttachmentPaths(turnId, turnMessages) {
    if (!turnId)
        return new Set();
    try {
        return new Set(userTurnAttachmentPaths(await turnMessages(turnId)));
    }
    catch {
        return new Set();
    }
}
export async function refusedDispatchAttachments(paths, options = {}) {
    const policy = options.policy ?? MODEL_NAMED_ATTACHMENT_POLICY;
    const userAttached = options.userAttached;
    const named = dispatchAttachments(paths);
    const refusals = [];
    const exempt = (filePath) => userAttached?.has(filePath) === true;
    const counted = named.filter((attachment) => !exempt(attachment.filePath));
    if (policy.limits && counted.length > DISPATCH_ATTACHMENT_LIMITS.count)
        refusals.push({ kind: 'too-many', limit: DISPATCH_ATTACHMENT_LIMITS.count });
    let total = 0;
    for (const { filePath } of named) {
        const { refusal, bytes } = await refuseOnePath(filePath, exempt(filePath) ? INHERITED_ATTACHMENT_POLICY : policy);
        if (refusal)
            refusals.push(refusal);
        else if (!exempt(filePath))
            total += bytes;
    }
    if (policy.limits && total > DISPATCH_ATTACHMENT_LIMITS.totalBytes)
        refusals.push({
            kind: 'total-too-large',
            bytes: total,
            limit: DISPATCH_ATTACHMENT_LIMITS.totalBytes,
        });
    return refusals;
}
/** Whether every refusal is the pre-existing "not a readable file" case. */
export function refusalsAreOnlyUnreadable(refusals) {
    return refusals.every((refusal) => refusal.kind === 'unreadable');
}
const mib = (bytes) => `${Math.round(bytes / (1024 * 1024))} MiB`;
/** One line for one refusal. */
function describeRefusal(refusal) {
    switch (refusal.kind) {
        case 'unreadable':
            return `not a readable file: ${refusal.filePath}`;
        case 'sensitive':
            return `refused as secret-bearing (the same list desktop grep and glob exclude): ${refusal.filePath}`;
        case 'too-many':
            return `too many attachments: at most ${refusal.limit} per dispatch`;
        case 'too-large':
            return `file is larger than ${mib(refusal.limit)}: ${refusal.filePath}`;
        case 'total-too-large':
            return `attachments add up to more than ${mib(refusal.limit)}`;
    }
}
/** One line per refusal, for the error the sender reads. */
export function describeDispatchAttachmentRefusals(refusals) {
    return refusals.map(describeRefusal).join('; ');
}
/**
 * The named paths that are not readable regular files, for the callers that only want that: the
 * user's own Turn attachments and the re-check at queue start. Both keep the pre-existing
 * readability-only behaviour — see `DispatchAttachmentPolicy`.
 */
export async function unreadableDispatchAttachments(paths) {
    const refusals = await refusedDispatchAttachments(paths, {
        policy: INHERITED_ATTACHMENT_POLICY,
    });
    return refusals.flatMap((refusal) => refusal.kind === 'unreadable' ? [refusal.filePath] : []);
}
/**
 * The local paths of the files the user attached in one Turn, in the order they were sent.
 * Only user rows count: a wake (a task report, a schedule) carries no attachments of the user's.
 * Both stored shapes are read — the structured `local.filePath` and the legacy `file_path` — and
 * an attachment with no local path (a cloud upload, an inline data URL) has nothing to hand on.
 */
function userTurnAttachmentPaths(messages) {
    const paths = [];
    for (const message of messages) {
        if (field(message, 'role') !== 'user')
            continue;
        const attachments = field(message, 'attachments');
        if (!Array.isArray(attachments))
            continue;
        for (const attachment of attachments) {
            const local = field(attachment, 'local');
            const filePath = field(local, 'filePath') ??
                field(local, 'file_path') ??
                field(attachment, 'filePath') ??
                field(attachment, 'file_path');
            if (typeof filePath === 'string' && filePath.trim())
                paths.push(filePath.trim());
        }
    }
    return paths;
}
/**
 * The files a dispatched task starts with.
 *
 * A list the assigner named is used as given, and the caller has already refused an unreadable
 * one. An empty list is the assigner saying "none". Naming nothing hands the task every readable
 * file the user attached in the dispatching Turn: the assigner sees those files, yet in practice
 * leaves the parameter out and only describes them in words (MCT-202611-RGZGEAHO), and a task
 * that works from a description of a screenshot cannot check what the screenshot shows. A Turn
 * that dispatches several tasks hands each of them these files.
 *
 * Reading the Turn is best-effort: a file since removed is skipped, and a dispatch that names
 * no Turn, or a Turn that cannot be read, hands on nothing rather than failing the dispatch.
 */
export async function taskAttachmentPaths(named, turnId, turnMessages) {
    if (named)
        return dispatchAttachments(named).map((attachment) => attachment.filePath);
    if (!turnId)
        return [];
    // One implementation of "read a Turn, take the user's attachment paths, treat a read failure as
    // none": the exemption set and the auto-inherited set must never disagree about the same Turn.
    const fromTurn = [...(await turnUserAttachmentPaths(turnId, turnMessages))];
    const unreadable = new Set(await unreadableDispatchAttachments(fromTurn));
    return fromTurn.filter((filePath) => !unreadable.has(filePath));
}
function field(value, key) {
    return typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined;
}
//# sourceMappingURL=dispatch-attachments.js.map