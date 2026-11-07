import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, open, readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
/** Append-only checkpoints: absence of a successful seal always means incomplete. */
export class ComputerUseCaptureStore {
    directory;
    issues = new Set();
    assets = new Map();
    sequence = 0;
    constructor(directory) {
        this.directory = directory;
    }
    static async create(config) {
        if (config.enabled !== true || config.localStorageConsent !== true) {
            throw new Error('computer_use_capture_storage_not_authorized');
        }
        if (!isAbsolute(config.directory))
            throw new Error('computer_use_capture_absolute_path_required');
        for (const value of [config.runId, config.caseId, config.caseVersion]) {
            if (!value?.trim())
                throw new Error('computer_use_capture_identity_required');
        }
        await mkdir(config.directory, { recursive: true, mode: 0o700 });
        const directory = await mkdtemp(join(config.directory, 'cu-'));
        await syncDirectory(config.directory);
        return new ComputerUseCaptureStore(directory);
    }
    async append(kind, payload) {
        const data = await this.externalize(payload, kind === 'tool_result');
        const record = JSON.stringify({
            sequence: ++this.sequence,
            timestampMs: Date.now(),
            kind,
            data,
        });
        // Refuse oversized evidence instead of silently truncating JSON or image content.
        if (Buffer.byteLength(record) > 16 * 1024 * 1024)
            throw new Error('capture_record_too_large');
        await durableWrite(join(this.directory, `${String(this.sequence).padStart(8, '0')}.json`), record);
        await syncDirectory(this.directory);
    }
    async verifyAssets() {
        for (const [hash, bytes] of this.assets) {
            try {
                const data = await readFile(join(this.directory, `${hash}.asset`));
                if (data.length !== bytes || sha256(data) !== hash)
                    this.issues.add('asset_hash_mismatch');
            }
            catch {
                this.issues.add('missing_asset');
            }
        }
    }
    async externalize(value, inspectResult) {
        if (Array.isArray(value)) {
            const result = [];
            for (const item of value)
                result.push(await this.externalize(item, inspectResult));
            return result;
        }
        if (typeof value === 'string')
            return this.externalizeText(value, inspectResult);
        if (!value || typeof value !== 'object')
            return value;
        const record = value;
        if (inspectResult)
            this.inspectResult(record);
        if (isImage(record))
            return this.externalizeImage(record);
        const result = {};
        for (const [key, item] of Object.entries(record))
            result[key] = await this.externalize(item, inspectResult);
        return result;
    }
    inspectResult(record) {
        if (record.truncated === true || record.incomplete === true)
            this.issues.add('truncated');
        if ([record.status, record.outcome, record.completion].includes('unknown'))
            this.issues.add('unknown_action');
    }
    async externalizeText(value, inspectResult) {
        // Structured driver facts are sometimes carried as JSON text in tool results.
        if (value.startsWith('{') || value.startsWith('[')) {
            let parsed;
            try {
                parsed = JSON.parse(value);
            }
            catch {
                /* Preserve ordinary text. */
            }
            if (parsed !== undefined) {
                const externalized = await this.externalize(parsed, inspectResult);
                return JSON.stringify(parsed) === JSON.stringify(externalized)
                    ? value
                    : JSON.stringify(externalized);
            }
        }
        if (inspectResult && /\btruncated\b/i.test(value))
            this.issues.add('truncated');
        if (/data:image\//i.test(value)) {
            this.issues.add('unsupported_inline_image');
            return { omitted: 'unsupported_inline_image' };
        }
        return value;
    }
    async externalizeImage(record) {
        const encoded = record.data ?? record.dataBase64;
        if (typeof encoded !== 'string' ||
            !encoded.length ||
            !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
            this.issues.add('missing_image');
            return { type: 'image', missing: true };
        }
        const bytes = Buffer.from(encoded, 'base64');
        const hash = sha256(bytes);
        if (!this.assets.has(hash)) {
            await durableWrite(join(this.directory, `${hash}.asset`), bytes);
            this.assets.set(hash, bytes.length);
        }
        return {
            type: 'image',
            artifact: `${hash}.asset`,
            sha256: hash,
            bytes: bytes.length,
            mimeType: record.mimeType,
            provenance: 'captured_content',
        };
    }
}
function isImage(record) {
    return (record.type === 'image' ||
        record.type === 'image_url' ||
        (typeof record.mimeType === 'string' && record.mimeType.startsWith('image/')));
}
export function sha256(value) {
    return createHash('sha256').update(value).digest('hex');
}
async function durableWrite(path, content) {
    const file = await open(path, 'wx', 0o600);
    try {
        await file.writeFile(content);
        await file.sync();
    }
    finally {
        await file.close();
    }
}
async function syncDirectory(path) {
    // Windows does not support opening directories for fsync via Node; file handles are still synced.
    if (process.platform === 'win32')
        return;
    const directory = await open(path, 'r');
    try {
        await directory.sync();
    }
    finally {
        await directory.close();
    }
}
//# sourceMappingURL=store.js.map