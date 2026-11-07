/**
 * Persistence for recorded review links.
 *
 * Entries are keyed by `<workspaceDir>\n<branch>` rather than by session id.
 * A review belongs to a branch, not to the conversation that happened to open
 * it, so keying by branch is what makes the status line keep working after the
 * session is resumed, forked, or replaced by a fresh one on the same checkout.
 *
 * Everything here is derived state: losing the file costs the user a status
 * line entry until the next `gh`/`glab` invocation, never real work. That is
 * why a malformed file is discarded rather than repaired.
 */
import fs, { existsSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
const REVIEW_LINK_FILE = 'review-links.json';
/**
 * Upper bound on retained entries. One entry per branch per workspace stays
 * small in normal use; the cap only matters for long-lived installs that
 * accumulate abandoned branches. Eviction drops the oldest recordings first.
 */
const MAX_ENTRIES = 500;
const VENDORS = new Set(['github', 'gitlab']);
const ORIGINS = new Set(['created', 'viewed']);
const mutationTails = new Map();
function isRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function isNonEmptyString(value) {
    return typeof value === 'string' && value.length > 0;
}
/**
 * Builds the lookup key for one workspace/branch pair.
 *
 * A newline separator cannot collide: it is legal in neither a POSIX path
 * component boundary we produce nor a git branch name (git rejects control
 * characters in refs).
 * @internal Exported only for focused tests.
 */
export function reviewLinkKey(workspaceDir, branch) {
    return `${workspaceDir}\n${branch}`;
}
function emptyReviewLinkData() {
    return { version: 1, links: {} };
}
/** @internal Exported only for focused tests. */
export function loadReviewLinkData(dataDir) {
    return loadReviewLinkFile(resolve(dataDir, REVIEW_LINK_FILE));
}
function loadReviewLinkFile(filePath) {
    if (!existsSync(filePath))
        return emptyReviewLinkData();
    try {
        const raw = JSON.parse(readFileSync(filePath, 'utf-8'));
        if (!isRecord(raw))
            return emptyReviewLinkData();
        const links = raw.links;
        if (!isRecord(links))
            return emptyReviewLinkData();
        const parsed = {};
        for (const [key, value] of Object.entries(links)) {
            const entry = sanitizeEntry(value);
            if (entry)
                parsed[key] = entry;
        }
        return { version: 1, links: parsed };
    }
    catch {
        // Corrupt or truncated cache — rebuildable, so start clean rather than
        // failing the caller.
        return emptyReviewLinkData();
    }
}
/**
 * Validates one persisted entry, returning `undefined` when any field is
 * missing or the wrong shape. Partial entries are dropped whole: a status line
 * item rendered from half-known data would be worse than no item.
 */
function sanitizeEntry(value) {
    if (!isRecord(value))
        return undefined;
    const { vendor, url, branch, origin, number, recordedAt } = value;
    if (!isNonEmptyString(vendor) || !VENDORS.has(vendor))
        return undefined;
    if (!isNonEmptyString(origin) || !ORIGINS.has(origin))
        return undefined;
    if (!isNonEmptyString(url) || !isNonEmptyString(branch))
        return undefined;
    if (!isPositiveInteger(number) || !isFiniteNumber(recordedAt))
        return undefined;
    return {
        vendor: vendor,
        origin: origin,
        url,
        branch,
        number,
        recordedAt,
    };
}
function isFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
}
function isPositiveInteger(value) {
    return typeof value === 'number' && Number.isInteger(value) && value > 0;
}
export class LocalReviewLinkStore {
    getDataDir;
    constructor(getDataDir) {
        this.getDataDir = getDataDir;
    }
    /**
     * Reads the review link recorded for one workspace/branch pair.
     *
     * Reads are synchronous and uncached because the only caller is the TUI
     * status line, which already refreshes on a timer and re-reads a small file.
     */
    read(workspaceDir, branch) {
        if (!workspaceDir || !branch)
            return undefined;
        const data = loadReviewLinkData(this.getDataDir());
        return data.links[reviewLinkKey(workspaceDir, branch)];
    }
    /**
     * Records a review link for one workspace/branch pair.
     *
     * A later recording replaces an earlier one for the same branch, except that
     * a `viewed` observation never overwrites a `created` one: the review this
     * session opened is the more specific fact, and `gh pr view` run afterwards
     * on the same branch should not downgrade it.
     */
    async record(workspaceDir, entry) {
        if (!workspaceDir || !entry.branch)
            return undefined;
        const key = reviewLinkKey(workspaceDir, entry.branch);
        return this.mutate((data) => {
            const previous = data.links[key];
            if (previous && previous.origin === 'created' && entry.origin === 'viewed') {
                return previous;
            }
            data.links[key] = entry;
            evictOverflow(data);
            return entry;
        });
    }
    async mutate(mutate) {
        const filePath = resolve(this.getDataDir(), REVIEW_LINK_FILE);
        const previous = mutationTails.get(filePath) ?? Promise.resolve();
        const operation = this.mutateAfter(previous, filePath, mutate);
        mutationTails.set(filePath, operation);
        try {
            return await operation;
        }
        finally {
            if (mutationTails.get(filePath) === operation)
                mutationTails.delete(filePath);
        }
    }
    async mutateAfter(previous, filePath, mutate) {
        try {
            await previous;
        }
        catch {
            // A failed write must not block subsequent mutations for this file.
        }
        const data = loadReviewLinkFile(filePath);
        const result = mutate(data);
        await this.write(filePath, data);
        return result;
    }
    async write(filePath, data) {
        await fs.promises.mkdir(dirname(filePath), { recursive: true });
        const tmpPath = join(dirname(filePath), `.review-links-tmp-${randomBytes(6).toString('hex')}`);
        try {
            await fs.promises.writeFile(tmpPath, JSON.stringify(data, null, 2), {
                encoding: 'utf-8',
                mode: 0o600,
            });
            await fs.promises.rename(tmpPath, filePath);
        }
        catch (err) {
            try {
                await fs.promises.unlink(tmpPath);
            }
            catch {
                // Cleanup is best-effort; preserve the original write failure.
            }
            throw err;
        }
    }
}
function evictOverflow(data) {
    const keys = Object.keys(data.links);
    if (keys.length <= MAX_ENTRIES)
        return;
    const oldestFirst = keys.sort((left, right) => (data.links[left]?.recordedAt ?? 0) - (data.links[right]?.recordedAt ?? 0));
    for (const key of oldestFirst.slice(0, keys.length - MAX_ENTRIES)) {
        delete data.links[key];
    }
}
/** @internal Exported only for focused tests. */
export function __resetReviewLinkMutationTailsForTests() {
    mutationTails.clear();
}
//# sourceMappingURL=review-link.js.map