import { access, readFile, realpath, writeFile } from './physical-fs.js';
/**
 * Captures the exact pre-edit file inside Pi's mutation-queue critical section.
 * The helper is created per execute, so concurrent agents cannot exchange
 * captures even when they edit the same path.
 *
 * With `tracking`, a session's record is refreshed after the edit only if it
 * matched the file before Pi read it; otherwise the record stays stale (or
 * absent) and a later overwrite asks for a fresh read. Edit itself never
 * requires a read.
 */
export function createCapturingEditOperations(tracking) {
    const pendingReads = new Map();
    const recordCurrent = new Map();
    const captures = new Map();
    const operations = {
        realpath,
        access,
        async readFile(path) {
            if (tracking)
                recordCurrent.set(path, await tracking.isRecordCurrent(path));
            const buffer = await readFile(path);
            pendingReads.set(path, buffer);
            return buffer;
        },
        async writeFile(path, content) {
            await writeFile(path, content, 'utf8');
            if (tracking && recordCurrent.get(path) === true)
                await tracking.refresh(path);
            const original = pendingReads.get(path);
            if (original) {
                const decoded = original.toString('utf8');
                captures.set(path, {
                    path,
                    originalFile: decoded.charCodeAt(0) === 0xfeff ? decoded.slice(1) : decoded,
                });
            }
        },
    };
    return {
        operations,
        takeCapture(absoluteHint) {
            const exact = captures.get(absoluteHint);
            if (exact)
                return exact;
            if (captures.size !== 1)
                return undefined;
            return captures.values().next().value;
        },
    };
}
//# sourceMappingURL=edit-capture.js.map