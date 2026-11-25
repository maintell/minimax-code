import { resolveBunnyHomeDir } from '@mavis/shared/local-runtime-paths';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
/**
 * Space directories under `<bunny>/spaces/`. A directory is found by the space ID it ends with,
 * never by its full name, so renaming a space never moves or loses its directory:
 *
 * - `<slug>-<uuid>`: the layout new spaces get (the slug comes from the name at creation);
 * - `<uuid>` (or any other plain ID, such as `default` of the space older versions created):
 *   the path a space without a directory resolves to.
 *
 * Entries starting with `.` (staging, trash, the Bunny database, OS files) are never spaces.
 *
 * Reserved names, never a space, a slug or a task's to write:
 * - under `<bunny>/`: `data/` (the Bunny database, `data/bunny.sqlite`) and `.trash/` (what
 *   deletes move away);
 * - under `spaces/`: every `.`-name, `.staging-<id>/` included;
 * - under a space: `meta.json`, `context.md`, `artifacts/` (the directory itself), `data/` and
 *   `.db/`.
 */
const SPACE_UUID = /(?:^|-)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG_MAX_LENGTH = 40;
export const SPACE_META_FILE = 'meta.json';
/** Every task's files: `<sid8>-<slug>/` folders and `<sid8>-<slug>.link.json` pointers. */
export const SPACE_ARTIFACTS_DIR = 'artifacts';
/** Files the user imports into a space, under `artifacts/`. */
export const SPACE_IMPORTS_DIR = '上下文';
/** Where a new space directory is built before it is renamed into place. */
export const SPACE_STAGING_PREFIX = '.staging-';
export const BUNNY_DATABASE_DIR = 'data';
export const BUNNY_TRASH_DIR = '.trash';
/**
 * The ID of the space older versions created as Bunny's default. Since v13 of the Bunny store it is
 * an ordinary space (renamed 默认事项); the library's own root chats still deliver into it while it
 * exists, as they did before.
 */
export const LEGACY_DEFAULT_SPACE_ID = 'default';
/**
 * Slugs that read like a reserved name once the leading `.` is gone (`.trash` slugs to `trash`),
 * or that match one exactly (`data`, the Bunny database directory). The
 * UUID suffix already keeps them apart on disk; this keeps the names unambiguous to people.
 */
const RESERVED_SLUGS = new Set([
    'db',
    'trash',
    'staging',
    'data',
    'artifacts',
    'meta-json',
    'context-md',
]);
export function spacesRoot(dataDir) {
    return path.join(resolveBunnyHomeDir(dataDir), 'spaces');
}
/** `<bunny>/.trash/`: deleted spaces are moved here, never removed outright. */
export function trashRoot(dataDir) {
    return path.join(resolveBunnyHomeDir(dataDir), BUNNY_TRASH_DIR);
}
/**
 * `<bunny>/data/`: the Bunny database directory (`data/bunny.sqlite`).
 * @internal Exported only for focused tests.
 */
export function bunnyDatabaseRoot(dataDir) {
    return path.join(resolveBunnyHomeDir(dataDir), BUNNY_DATABASE_DIR);
}
/** The staging directory a new space directory is built in. */
export function spaceStagingDirectory(dataDir, id) {
    assertSpaceId(id);
    return path.join(spacesRoot(dataDir), `${SPACE_STAGING_PREFIX}${id}`);
}
export function assertSpaceId(id) {
    if (!id || path.basename(id) !== id || id === '.' || id === '..')
        throw new Error('Invalid space ID');
}
/**
 * The directory-name slug of a space name. Same rule as task directories (NFC, every run of
 * non-letter/digit characters becomes `-`, trimmed), capped at 40 characters. A slug that reads
 * like a reserved name gets a `space-` prefix.
 * @internal Exported only for focused tests.
 */
export function spaceDirectorySlug(name) {
    const slug = Array.from(name
        .normalize('NFC')
        .replace(/[^\p{L}\p{N}]+/gu, '-')
        .replace(/^-|-$/g, ''))
        .slice(0, SLUG_MAX_LENGTH)
        .join('')
        .replace(/-+$/, '');
    if (!slug)
        return 'space';
    return RESERVED_SLUGS.has(slug.toLowerCase()) ? `space-${slug}` : slug;
}
/**
 * The name a space's directory gets when it is created: `<slug>-<uuid>`. An ID that is not a
 * UUID keeps the plain ID, the only name that still resolves back to it.
 */
export function spaceDirectoryName(id, name) {
    assertSpaceId(id);
    return UUID.test(id) ? `${spaceDirectorySlug(name)}-${id}` : id;
}
/**
 * The space ID a directory name stands for, or undefined when it is not a space directory.
 * @internal Exported only for focused tests.
 */
export function spaceIdOfDirectoryName(entry) {
    if (!entry || entry.startsWith('.'))
        return undefined;
    return SPACE_UUID.exec(entry)?.[1] ?? entry;
}
/** Every space directory on disk, grouped by space ID. One ID can map to several directories. */
export function scanSpaceDirectories(dataDir) {
    const root = spacesRoot(dataDir);
    const found = new Map();
    let entries;
    try {
        entries = readdirSync(root, { withFileTypes: true });
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return found;
        throw error;
    }
    for (const entry of entries) {
        if (!entry.isDirectory())
            continue;
        const id = spaceIdOfDirectoryName(entry.name);
        if (!id)
            continue;
        const list = found.get(id) ?? [];
        list.push(path.join(root, entry.name));
        found.set(id, list);
    }
    return found;
}
/**
 * Picks one directory when several claim the same ID: the one whose meta.json names this
 * space, and among those (or among all, when none does) the one created first.
 * @internal Exported only for focused tests.
 */
export function pickSpaceDirectory(id, directories) {
    if (directories.length <= 1)
        return directories[0];
    const confirmed = directories.filter((directory) => metaSpaceId(directory) === id);
    const pool = confirmed.length > 0 ? confirmed : directories;
    return [...pool].sort((left, right) => createdAtMs(left) - createdAtMs(right) || left.localeCompare(right))[0];
}
/**
 * The directory of a space. A space without a directory resolves to the plain `spaces/<id>`
 * path; new spaces get `<slug>-<id>` from the staged create, and startup reconciliation builds
 * that for a row whose directory is missing.
 */
export function resolveSpaceDirectory(dataDir, id) {
    assertSpaceId(id);
    const found = pickSpaceDirectory(id, scanSpaceDirectories(dataDir).get(id) ?? []);
    return found ?? path.join(spacesRoot(dataDir), id);
}
function metaSpaceId(directory) {
    try {
        const meta = JSON.parse(readFileSync(path.join(directory, SPACE_META_FILE), 'utf8'));
        return meta && typeof meta === 'object' && 'space_id' in meta
            ? String(meta.space_id)
            : undefined;
    }
    catch {
        return undefined;
    }
}
function createdAtMs(directory) {
    try {
        const stat = statSync(directory);
        return stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs;
    }
    catch {
        return Number.POSITIVE_INFINITY;
    }
}
//# sourceMappingURL=space-directory.js.map