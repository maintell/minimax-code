import { readFileSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { replaceFileAtomically } from '../../../../infra/file/jsonl.js';
import { SPACE_META_FILE, resolveSpaceDirectory, scanSpaceDirectories } from './space-directory.js';
export function spaceMetaOf(space, options) {
    return {
        schemaVersion: 1,
        mirrorOf: 'bunny/data/bunny.sqlite#local_runtime_task_spaces',
        readOnly: true,
        space_id: space.id,
        space_name: space.name,
        goal: space.objective,
        linked_projects: [...space.projects],
        'context-path': 'context.md',
        status: options.status ?? 'active',
        synced_at_ms: options.syncedAtMs,
    };
}
/** The parsed meta.json of a directory, or undefined when it is missing or not JSON. */
export function readSpaceMeta(directory) {
    try {
        return JSON.parse(readFileSync(path.join(directory, SPACE_META_FILE), 'utf8'));
    }
    catch {
        return undefined;
    }
}
/** Whether a stored mirror says exactly what the database says, whenever it was written. */
export function spaceMetaMatches(stored, expected) {
    if (!stored || typeof stored !== 'object' || Array.isArray(stored))
        return false;
    return isDeepStrictEqual(withoutSyncTime(stored), withoutSyncTime(expected));
}
function withoutSyncTime(meta) {
    return Object.fromEntries(Object.entries(meta).filter(([key]) => key !== 'synced_at_ms'));
}
/** Atomically replaces the space's meta.json with the mirror of its row. */
export async function writeSpaceMeta(dataDir, space, options) {
    await writeSpaceMetaIn(resolveSpaceDirectory(dataDir, space.id), space, options);
}
/** Atomically writes the mirror of a row into `directory`, e.g. a staging directory. */
export async function writeSpaceMetaIn(directory, space, options) {
    const meta = spaceMetaOf(space, { status: options.status, syncedAtMs: options.nowMs });
    await replaceFileAtomically(path.join(directory, SPACE_META_FILE), `${JSON.stringify(meta, null, 2)}\n`);
}
/** Directories on disk that no database row claims, and IDs claimed by several directories. */
export function unclaimedSpaceDirectories(dataDir, spaceIds) {
    const orphans = [];
    const duplicates = new Map();
    for (const [id, directories] of scanSpaceDirectories(dataDir)) {
        if (!spaceIds.has(id))
            orphans.push(...directories);
        else if (directories.length > 1)
            duplicates.set(id, directories);
    }
    return { orphans: orphans.sort(), duplicates };
}
//# sourceMappingURL=space-meta.js.map