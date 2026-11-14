import { lstatSync, readFileSync } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
const INSTANCE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MARKER_FILE_NAME = '.agent-instance-id';
const MARKER_MAX_BYTES = 128;
/**
 * The identity marker of an Agent directory directly under `<dataDir>/agents`,
 * or undefined when the name is absent or would leave that directory. Both
 * readers below resolve the same path, so a name that escapes it is refused
 * before any file is touched.
 */
function agentInstanceMarker(dataDir, agentName) {
    if (!agentName)
        return undefined;
    const agentsDir = resolve(dataDir, 'agents');
    const agentDir = resolve(agentsDir, agentName);
    if (dirname(agentDir) !== agentsDir)
        return undefined;
    return join(agentDir, MARKER_FILE_NAME);
}
/** The Agent directory holding `marker`, which both readers stat as a real directory. */
function agentMarkerDirectory(marker) {
    return dirname(marker);
}
/** Whether the marker may be read at all: an ordinary, small, unlinked file. */
function isReadableMarker(stats) {
    return stats.isFile() && !stats.isSymbolicLink() && stats.size <= MARKER_MAX_BYTES;
}
/** Whether the marker is the same file it was before the read. */
function isUnchangedMarker(before, after) {
    return (after.isFile() &&
        !after.isSymbolicLink() &&
        after.ino === before.ino &&
        after.dev === before.dev &&
        after.mtimeMs === before.mtimeMs);
}
/** Whether the Agent directory itself is a real directory, not a link to one. */
function isRealAgentDirectory(stats) {
    return stats.isDirectory() && !stats.isSymbolicLink();
}
/** Read-only incarnation check: never materializes an Agent or reads its configuration. */
export async function matchesAgentResourceInstance(dataDir, agentName, expectedInstanceId) {
    if (!INSTANCE_ID_PATTERN.test(expectedInstanceId))
        return false;
    const marker = agentInstanceMarker(dataDir, agentName);
    if (!marker)
        return false;
    try {
        const directory = await lstat(agentMarkerDirectory(marker));
        if (!isRealAgentDirectory(directory))
            return false;
        const before = await lstat(marker);
        if (!isReadableMarker(before))
            return false;
        const value = (await readFile(marker, 'utf8')).trim();
        const after = await lstat(marker);
        return value === expectedInstanceId && isUnchangedMarker(before, after);
    }
    catch {
        // Private resources are optional; a missing/unreadable marker cannot block a frozen Session.
        return false;
    }
}
/**
 * The synchronous twin of `matchesAgentResourceInstance`, for the callers that
 * resolve a scope while a Turn is assembled and have no `await` to spare (the
 * PTC script roots). Same rules, same order, same answers: both readers share
 * the path, the marker shape and the before/after stat comparison above, so a
 * scope decided here and a scope decided there cannot disagree.
 */
export function matchesAgentResourceInstanceSync(dataDir, agentName, expectedInstanceId) {
    if (!INSTANCE_ID_PATTERN.test(expectedInstanceId))
        return false;
    const marker = agentInstanceMarker(dataDir, agentName);
    if (!marker)
        return false;
    try {
        const directory = lstatSync(agentMarkerDirectory(marker));
        if (!isRealAgentDirectory(directory))
            return false;
        const before = lstatSync(marker);
        if (!isReadableMarker(before))
            return false;
        const value = readFileSync(marker, 'utf8').trim();
        const after = lstatSync(marker);
        return value === expectedInstanceId && isUnchangedMarker(before, after);
    }
    catch {
        // Private resources are optional; a missing/unreadable marker cannot block a frozen Session.
        return false;
    }
}
//# sourceMappingURL=local-runtime-agent-resource-instance.js.map