import { appendFileSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
const DEFAULT_MAX_FILE_BYTES = 16 * 1024 * 1024;
export class JsonlFileObservabilitySink {
    activeStamp = '';
    activeDir = '';
    activeRotationIndex = 0;
    activePath = '';
    activeBytes = 0;
    dir;
    dateStamp;
    filePrefix;
    maxFileBytes;
    nowMs;
    onWriteError;
    constructor(options) {
        this.dir = options.dir;
        this.dateStamp = options.dateStamp ?? formatDateStamp;
        this.filePrefix = options.filePrefix ?? 'events';
        this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
        this.nowMs = options.nowMs ?? (() => Date.now());
        this.onWriteError = options.onWriteError ?? (() => undefined);
    }
    emit(event) {
        try {
            const stamp = this.dateStamp(this.nowMs());
            const payload = `${JSON.stringify(event)}\n`;
            const payloadBytes = Buffer.byteLength(payload, 'utf8');
            const dir = this.dir();
            mkdirSync(dir, { recursive: true });
            if (stamp !== this.activeStamp || dir !== this.activeDir) {
                this.activeStamp = stamp;
                this.activeDir = dir;
                this.activeRotationIndex = 0;
                this.activePath = join(dir, fileNameFor(this.filePrefix, stamp, 0));
                this.activeBytes = sizeOnDiskOrZero(this.activePath);
            }
            if (this.maxFileBytes > 0 &&
                this.activeBytes > 0 &&
                this.activeBytes + payloadBytes > this.maxFileBytes) {
                this.rotate(dir, stamp, payloadBytes);
            }
            appendFileSync(this.activePath, payload, { encoding: 'utf-8' });
            this.activeBytes += payloadBytes;
        }
        catch (err) {
            try {
                this.onWriteError(err instanceof Error ? err : new Error(String(err)));
            }
            catch {
                // Drop observer errors; logging is fail-open.
            }
        }
    }
    rotate(dir, stamp, payloadBytes) {
        let nextIndex = this.activeRotationIndex + 1;
        for (let attempt = 0; attempt < 10_000; attempt += 1) {
            const candidate = join(dir, fileNameFor(this.filePrefix, stamp, nextIndex));
            const candidateBytes = sizeOnDiskOrZero(candidate);
            if (candidateBytes === 0 || candidateBytes + payloadBytes <= this.maxFileBytes) {
                this.activeRotationIndex = nextIndex;
                this.activePath = candidate;
                this.activeBytes = candidateBytes;
                return;
            }
            nextIndex += 1;
        }
    }
}
function fileNameFor(prefix, stamp, rotationIndex) {
    if (rotationIndex === 0)
        return `${prefix}-${stamp}.jsonl`;
    return `${prefix}-${stamp}.${rotationIndex}.jsonl`;
}
function sizeOnDiskOrZero(path) {
    try {
        return statSync(path).size;
    }
    catch {
        return 0;
    }
}
function formatDateStamp(epochMs) {
    const d = new Date(epochMs);
    const y = d.getUTCFullYear().toString().padStart(4, '0');
    const m = (d.getUTCMonth() + 1).toString().padStart(2, '0');
    const day = d.getUTCDate().toString().padStart(2, '0');
    return `${y}-${m}-${day}`;
}
//# sourceMappingURL=jsonl-file-sink.js.map