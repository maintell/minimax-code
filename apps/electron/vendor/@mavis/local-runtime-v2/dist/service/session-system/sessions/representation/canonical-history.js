import { access } from 'node:fs/promises';
import { CanonicalHistoryJsonlDataSource } from '../../../../infra/file/canonical-history.js';
export function createCanonicalHistoryFileAdapter(options = {}) {
    return new JsonlCanonicalHistoryFileAdapter(options);
}
class JsonlCanonicalHistoryFileAdapter {
    options;
    cachedSource;
    constructor(options) {
        this.options = options;
    }
    async targetExists(path) {
        return exists(path);
    }
    async readTarget(path) {
        if (!(await exists(path)))
            return undefined;
        return this.source(path).readActive();
    }
    async readTargetStrict(path) {
        if (!(await exists(path)))
            return undefined;
        return this.source(path).readActiveStrict();
    }
    async readActive(path) {
        return this.source(path).readActive();
    }
    async readActiveStrict(path) {
        return this.source(path).readActiveStrict();
    }
    async readEnvelopesStrict(path) {
        return this.source(path).readEnvelopesStrict();
    }
    async readStrict(path) {
        return this.source(path).readStrict();
    }
    async publishInitial(path, records) {
        return this.source(path).publishInitial(records);
    }
    async append(path, records, verifiedActive) {
        await this.source(path).append(records, verifiedActive);
    }
    async replace(path, records) {
        await this.source(path).replace(records);
    }
    async replaceActive(path, records) {
        await this.source(path).replaceActive(records);
    }
    async publishSnapshot(snapshotPath, records) {
        return this.source(snapshotPath).publishSnapshot(snapshotPath, records);
    }
    source(path) {
        if (this.options.reuseDecodedRecords && this.cachedSource?.path === path) {
            return this.cachedSource.source;
        }
        const source = new CanonicalHistoryJsonlDataSource({
            activePath: path,
            reuseDecodedRecords: this.options.reuseDecodedRecords,
            ...(this.options.onMalformedLine ? { onMalformedLine: this.options.onMalformedLine } : {}),
        });
        if (this.options.reuseDecodedRecords)
            this.cachedSource = { path, source };
        return source;
    }
}
async function exists(path) {
    try {
        await access(path);
        return true;
    }
    catch (error) {
        if (isMissing(error))
            return false;
        throw error;
    }
}
function isMissing(error) {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
//# sourceMappingURL=canonical-history.js.map