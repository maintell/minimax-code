import { appendFile, mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ToolOutputArtifactRepository } from '../../persistence/tool-output-artifact.repository.js';
/** Session-directory files of the emergency rebuild (spec 10.2, 12.4). */
const STATE_FILE = 'bunny-emergency.json';
const RECORDS_FILE = 'bunny-emergency.jsonl';
const SNAPSHOTS_DIRECTORY = 'snapshots';
const SNAPSHOT_FILE = /^g\d{12}--.+\.jsonl$/u;
/**
 * The emergency rebuild's files in the Session's own directory, next to its
 * canonical history: outside `snapshots/`, so no history scan or Bunny backup
 * export parses them, deleted with the Session, collected by the diagnostics
 * bundle with the directory.
 * @internal Exported only for focused tests.
 */
export function createEmergencyFileStore(input) {
    const directory = async (sessionId) => {
        const found = await input.sessionDirectory(sessionId);
        if (!found)
            throw new Error('Bunny emergency store: the Session has no history directory.');
        return found;
    };
    return {
        readState: async (sessionId) => {
            const path = join(await directory(sessionId), STATE_FILE);
            let text;
            try {
                text = await readFile(path, 'utf8');
            }
            catch (error) {
                if (isMissing(error))
                    return undefined;
                throw error;
            }
            return parseState(text);
        },
        writeState: async (sessionId, state) => {
            const root = await directory(sessionId);
            await mkdir(root, { recursive: true });
            const path = join(root, STATE_FILE);
            const staged = `${path}.${String(process.pid)}.tmp`;
            await writeFile(staged, `${JSON.stringify(state)}\n`, { mode: 0o600 });
            await rename(staged, path);
        },
        appendRecord: async (sessionId, record) => {
            const root = await directory(sessionId);
            await mkdir(root, { recursive: true });
            await appendFile(join(root, RECORDS_FILE), `${JSON.stringify(record)}\n`, { mode: 0o600 });
        },
        latestBackup: async (sessionId) => {
            const snapshots = join(await directory(sessionId), SNAPSHOTS_DIRECTORY);
            let names;
            try {
                names = await readdir(snapshots);
            }
            catch (error) {
                if (isMissing(error))
                    return undefined;
                throw error;
            }
            // The generation leads the name; a history repair can leave two snapshots of one
            // generation, and the one the rebuild just wrote is the newer.
            const newest = names
                .filter((name) => SNAPSHOT_FILE.test(name))
                .sort()
                .filter((name, _index, sorted) => name.slice(0, 13) === sorted.at(-1)?.slice(0, 13));
            if (newest.length < 2)
                return newest[0];
            const written = await Promise.all(newest.map(async (name) => ({
                name,
                mtimeMs: (await stat(join(snapshots, name))).mtimeMs,
            })));
            return written.reduce((latest, next) => (next.mtimeMs > latest.mtimeMs ? next : latest)).name;
        },
    };
}
/** Where an emergency rebuild moves foreground content, under the Session's `reports/` (spec 4.5). */
const EMERGENCY_FILES_DIRECTORY = 'emergency-rebuild';
/**
 * Everything an emergency rebuild keeps on disk for a Bunny main Session:
 * its limits and records next to the canonical history, and the files it
 * moves content into under `reports/emergency-rebuild/`, written atomically
 * and by content, with a copy cut into short lines when a line is too long
 * for the read tool. `readableDirectory` is the read grant of those files,
 * side-effect free.
 */
export function createEmergencyArtifacts(artifacts) {
    const writer = new ToolOutputArtifactRepository({
        directoryName: EMERGENCY_FILES_DIRECTORY,
        resolveSessionReportsDirectory: (id) => artifacts.ensureReportsDirectory(id),
        inspectSessionReportsDirectory: (id) => artifacts.inspectReportsDirectory(id),
    });
    return {
        store: createEmergencyFileStore({
            sessionDirectory: async (sessionId) => {
                const snapshots = await artifacts.inspectSnapshotsDirectory(sessionId);
                return snapshots === undefined ? undefined : dirname(snapshots);
            },
        }),
        files: {
            saveText: async (sessionId, item) => {
                const written = await writer.write({
                    sessionId,
                    toolCallId: item.key,
                    toolName: item.kind,
                    text: item.text,
                    originalBytes: Buffer.byteLength(item.text),
                    sensitive: false,
                });
                const raw = Reflect.get(written.metadata, 'raw_reference');
                return typeof raw === 'string'
                    ? { path: raw, readablePath: written.reference }
                    : { path: written.reference };
            },
            saveMedia: async (sessionId, item) => {
                const written = await writer.writeImage({
                    sessionId,
                    toolCallId: item.key,
                    toolName: item.kind,
                    data: item.data,
                    mimeType: item.mimeType,
                });
                return { path: written.reference };
            },
        },
        readableDirectory: (sessionId) => writer.readableDirectory(sessionId),
    };
}
function parseState(text) {
    let value;
    try {
        value = JSON.parse(text);
    }
    catch {
        return undefined;
    }
    if (!value || typeof value !== 'object')
        return undefined;
    const succeeded = Reflect.get(value, 'succeeded');
    if (typeof succeeded !== 'boolean')
        return undefined;
    const segmentId = nonEmptyString(Reflect.get(value, 'segmentId'));
    const providerSessionId = nonEmptyString(Reflect.get(value, 'providerSessionId'));
    const committing = parseCommitting(Reflect.get(value, 'committing'));
    return {
        ...(segmentId ? { segmentId } : {}),
        succeeded,
        ...(providerSessionId ? { providerSessionId } : {}),
        ...(committing ? { committing } : {}),
    };
}
function parseCommitting(value) {
    if (!value || typeof value !== 'object')
        return undefined;
    const from = Reflect.get(value, 'from');
    const providerSessionId = nonEmptyString(Reflect.get(value, 'providerSessionId'));
    if (!providerSessionId || (from !== null && nonEmptyString(from) === undefined))
        return undefined;
    return {
        from: from,
        providerSessionId,
        ...(Reflect.get(value, 'reset') === true ? { reset: true } : {}),
    };
}
function nonEmptyString(value) {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}
function isMissing(error) {
    return typeof error === 'object' && error !== null && Reflect.get(error, 'code') === 'ENOENT';
}
//# sourceMappingURL=emergency-state.repository.js.map