import path from 'node:path';
import { isInside } from '../../permission/index.js';
import { SPACE_ARTIFACTS_DIR, SPACE_CONTEXT_ARCHIVE_FILE, } from '../../session-system/index.js';
import { isCoordinatorAgent } from '@mavis/shared/agent-coordination';
import { PERMISSION_RUNTIME_DIRECTORY, PERMISSION_SPACE_CONTEXT_ARCHIVE, PERMISSION_SPACE_CONTEXT_FILE, PERMISSION_TASK_SPACE_FILES, } from '../../coordinator-text/index.js';
/**
 * Bunny's runtime protected roots, for every Session, in the order they are checked:
 *
 * - The memory directory belongs to the memory pipeline (remember, background
 *   upkeep, settings saves), Bunny's own Sessions included.
 * - The Bunny database (`<bunny>/data/`) and trash (`<bunny>/.trash/`) belong
 *   to the runtime, Bunny's own Sessions included.
 * - A space's own files are the coordinator's: `context.md`, the `meta.json`
 *   mirror, `data/` and `.db/`. Every other Session only reads them; the
 *   coordinator writes them through its space tools.
 * - No Session writes a space's `context.md` directly, the coordinator
 *   included: only `bunny_task_space_context_write` checks the revision a user edit
 *   moved. No Session writes `context-archive.md` either: only the runtime's
 *   tidy appends the summaries it replaced.
 */
export function assignmentProtectedRoots(roots, roster) {
    return [
        {
            directory: roots.memory,
            reason: 'Bunny memory files are maintained by the memory pipeline only; use the remember tool instead of writing them directly.',
        },
        ...(roots.runtime ?? []).map((directory) => ({
            directory,
            reason: PERMISSION_RUNTIME_DIRECTORY,
        })),
        ...(roots.spaces
            ? [
                {
                    directory: roots.spaces,
                    protects: protectsSpaceFiles,
                    exempts: (session) => isCoordinatorAgent(roster.coordinationOf(session?.agentName)),
                    reason: PERMISSION_TASK_SPACE_FILES,
                },
                {
                    directory: roots.spaces,
                    protects: protectsSpaceFile('context.md'),
                    reason: PERMISSION_SPACE_CONTEXT_FILE,
                },
                {
                    directory: roots.spaces,
                    protects: protectsSpaceFile(SPACE_CONTEXT_ARCHIVE_FILE),
                    reason: PERMISSION_SPACE_CONTEXT_ARCHIVE,
                },
            ]
            : []),
    ];
}
/** A protected path of `<spacesRoot>/<space>/`, or a whole space directory. */
function protectsSpaceFiles(root, target) {
    if (!isInside(root, target))
        return false;
    const [, ...rest] = path.relative(root, target).split(path.sep);
    // Deleting or moving a whole space directory also removes its context.md.
    return rest.length === 0 || isProtectedSpacePath(rest.join(path.sep));
}
/**
 * `<spacesRoot>/<space>/<name>`, written by no Session, the coordinator included: `context.md`
 * goes through the space commands, `context-archive.md` only through the runtime's tidy.
 */
function protectsSpaceFile(name) {
    return (root, target) => {
        if (!isInside(root, target))
            return false;
        const [, ...rest] = path.relative(root, target).split(path.sep);
        return rest.length === 1 && rest[0]?.toLowerCase() === name;
    };
}
/** Files directly under a space directory that only Bunny and the runtime write (lower case). */
const PROTECTED_SPACE_FILES = new Set([
    'context.md',
    'context-archive.md',
    'meta.json',
]);
/** Directories directly under a space directory that only Bunny and the runtime write. */
const PROTECTED_SPACE_DIRECTORIES = new Set(['data', '.db']);
/**
 * `context.md`, `meta.json`, `data/**` and `.db/**`, relative to a space directory. APFS
 * and NTFS ignore case by default, so the names are compared that way.
 */
export function isProtectedSpacePath(relative) {
    const [first = '', ...rest] = relative.split(/[\\/]/);
    const name = first.toLowerCase();
    return rest.length === 0
        ? PROTECTED_SPACE_FILES.has(name) ||
            PROTECTED_SPACE_DIRECTORIES.has(name) ||
            name === SPACE_ARTIFACTS_DIR
        : PROTECTED_SPACE_DIRECTORIES.has(name);
}
//# sourceMappingURL=protected-paths.js.map