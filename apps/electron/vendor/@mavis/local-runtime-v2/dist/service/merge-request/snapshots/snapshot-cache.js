import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
/**
 * The last answers the runtime read from GitLab and GitHub, kept on disk so the
 * first panel read after a restart can show them at once while a background read
 * refreshes them. Only summaries are kept: jobs, threads and the rest of the
 * details are read again when a card is expanded. Nothing secret is stored; the
 * file holds titles, branch names, links and the account names glab / gh report.
 */
/** Bumped whenever the stored shape changes; a file of another version is ignored. */
const CACHE_VERSION = 1;
/** A cache in one JSON file, replaced atomically so a crash never leaves half a file. */
export function fileMergeRequestCache(path) {
    return {
        async load() {
            let text;
            try {
                text = await readFile(path, 'utf8');
            }
            catch {
                return undefined;
            }
            return parseCache(text);
        },
        async save(data) {
            await mkdir(dirname(path), { recursive: true });
            const temporary = `${path}.${String(process.pid)}.tmp`;
            await writeFile(temporary, JSON.stringify({ version: CACHE_VERSION, ...data }), 'utf8');
            await rename(temporary, path);
        },
    };
}
/**
 * Reads a stored cache, dropping anything malformed: a broken file only costs
 * the first read its head start.
 * @internal Exported only for focused tests.
 */
export function parseCache(text) {
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch {
        return undefined;
    }
    if (!isRecord(parsed) || parsed['version'] !== CACHE_VERSION)
        return undefined;
    const gateway = isRecord(parsed['gateway']) ? parsed['gateway'] : {};
    return {
        snapshots: listOf(parsed['snapshots']).flatMap(toCachedSnapshot),
        branches: listOf(parsed['branches']).flatMap(toCachedBranch),
        gateway: {
            probes: listOf(gateway['probes']).flatMap(toCachedProbe),
            hostLists: listOf(gateway['hostLists']).flatMap(toCachedHostList),
        },
    };
}
/** A snapshot as it is stored: the summary without the details read for an expanded card. */
export function summaryOnly(snapshot) {
    const copy = {
        ...snapshot,
    };
    delete copy.jobs;
    delete copy.discussions;
    delete copy.description;
    delete copy.reviewers;
    delete copy.commits;
    return copy;
}
function toCachedSnapshot(entry) {
    const { key, atMs, snapshot } = entry;
    if (typeof key !== 'string' || typeof atMs !== 'number' || !isStoredSnapshot(snapshot))
        return [];
    return [{ key, atMs, snapshot }];
}
/**
 * The runtime wrote this file from its own snapshots, so checking the fields
 * every card reads is enough to keep a foreign or truncated file from being shown.
 */
function isStoredSnapshot(value) {
    return (isRecord(value) &&
        isStoredRef(value['ref']) &&
        isRecord(value['review']) &&
        Array.isArray(value['blockers']) &&
        STRING_FIELDS.every((field) => typeof value[field] === 'string') &&
        BOOLEAN_FIELDS.every((field) => typeof value[field] === 'boolean'));
}
const STRING_FIELDS = ['webUrl', 'title', 'state', 'status'];
const BOOLEAN_FIELDS = ['draft', 'hasConflicts', 'mergeable'];
function isStoredRef(value) {
    return (isRecord(value) &&
        (value['platform'] === 'gitlab' || value['platform'] === 'github') &&
        typeof value['host'] === 'string' &&
        typeof value['projectPath'] === 'string' &&
        typeof value['number'] === 'number');
}
function toCachedBranch(entry) {
    const { key, atMs, refKeys } = entry;
    if (typeof key !== 'string' || typeof atMs !== 'number' || !Array.isArray(refKeys))
        return [];
    const keys = refKeys.filter((value) => typeof value === 'string');
    return keys.length === refKeys.length ? [{ key, atMs, refKeys: keys }] : [];
}
const PROBE_AUTH = new Set(['ready', 'not_authenticated', 'unavailable']);
function toCachedProbe(entry) {
    const { key, atMs, probe } = entry;
    if (typeof key !== 'string' || typeof atMs !== 'number' || !isRecord(probe))
        return [];
    const { installed, auth, version, accountLogin, message } = probe;
    if (typeof installed !== 'boolean' || typeof auth !== 'string' || !PROBE_AUTH.has(auth))
        return [];
    return [
        {
            key,
            atMs,
            probe: {
                installed,
                auth: auth,
                ...(typeof version === 'string' ? { version } : {}),
                ...(typeof accountLogin === 'string' ? { accountLogin } : {}),
                ...(typeof message === 'string' ? { message } : {}),
            },
        },
    ];
}
function toCachedHostList(entry) {
    const { platform, atMs, hosts } = entry;
    if ((platform !== 'gitlab' && platform !== 'github') || typeof atMs !== 'number')
        return [];
    if (!Array.isArray(hosts))
        return [];
    const names = hosts.filter((host) => typeof host === 'string');
    return names.length === hosts.length ? [{ platform, atMs, hosts: names }] : [];
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function listOf(value) {
    return Array.isArray(value) ? value.filter(isRecord) : [];
}
//# sourceMappingURL=snapshot-cache.js.map