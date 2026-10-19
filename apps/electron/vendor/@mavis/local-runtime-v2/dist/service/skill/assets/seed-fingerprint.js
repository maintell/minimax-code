/**
 * Content fingerprints for marker-driven builtin skill seeding.
 *
 * Uses only asar-compatible fs APIs (`readdirSync` + `readFileSync` +
 * `statSync`) so fingerprints can be computed from an asar-packed source dir.
 *
 * The per-skill aggregate algorithm is mirrored by
 * `scripts/lib/seed-fingerprints.mjs` for the build-time
 * `.seed-fingerprints.json`; keep both implementations in sync (locked by the
 * cross-implementation parity test in
 * packages/local-runtime-v2/test/integration/skill/seed-builtin-marker.integration.test.ts).
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
/**
 * Source-side fingerprint of one skill dir (runtime fallback when no
 * build-time `.seed-fingerprints.json` entry is bundled). Hashes every
 * regular file (symlinks are read as files, like the seeding copy itself;
 * other entry types are skipped; empty directories are ignored). Relative
 * paths always use `/` separators for cross-platform stability.
 *
 * Strict like the build-time mjs mirror: an unreadable entry (dangling link,
 * link to a directory, EACCES) throws and fails the whole skill — a silently
 * skipped entry would desync the aggregate from the copied output.
 */
export function fingerprintSkillDir(skillDir) {
    const files = {};
    collectInto(skillDir, '', files);
    return { aggregate: aggregateSeedFingerprint(files) };
}
/**
 * Combined marker value = sha256 over `v1\0` + `${skillName}\0${aggregate}`
 * lines joined with `\n`, entries sorted by skillName, enabled skills only.
 */
export function combinedSeedFingerprint(aggregates) {
    const lines = [...aggregates.entries()]
        .sort(([a], [b]) => compareNames(a, b))
        .map(([skillName, aggregate]) => `${skillName}\u0000${aggregate}`);
    return createHash('sha256')
        .update(`v1\u0000${lines.join('\n')}`)
        .digest('hex');
}
/**
 * Aggregate = sha256 over `${relPath}\0${sha256}\0${x ? 1 : 0}` lines joined
 * with `\n`, entries sorted by relPath.
 */
function aggregateSeedFingerprint(files) {
    const lines = Object.entries(files)
        .sort(([a], [b]) => compareNames(a, b))
        .map(([relPath, file]) => `${relPath}\u0000${file.sha256}\u0000${file.x ? 1 : 0}`);
    return createHash('sha256').update(lines.join('\n')).digest('hex');
}
function collectInto(dir, relPrefix, files) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const absPath = join(dir, entry.name);
        const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
            collectInto(absPath, relPath, files);
        }
        else if (entry.isFile() || entry.isSymbolicLink()) {
            // Symlinks are leaves: file links are read through (parity with the
            // seeding copy), links to directories fail the read (EISDIR) — the
            // walk never descends through a link.
            const content = readFileSync(absPath);
            const x = process.platform === 'win32' ? false : (statSync(absPath).mode & 0o111) !== 0;
            files[relPath] = { sha256: createHash('sha256').update(content).digest('hex'), x };
        }
        // Skip other entry types (sockets, block devices, etc.)
    }
}
function compareNames(a, b) {
    if (a < b)
        return -1;
    return a > b ? 1 : 0;
}
//# sourceMappingURL=seed-fingerprint.js.map