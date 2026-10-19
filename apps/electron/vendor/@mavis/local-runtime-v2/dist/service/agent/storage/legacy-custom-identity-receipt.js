import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { publishFileIfAbsent } from '../../../infra/file/jsonl.js';
const RECEIPT_FILE = 'legacy-custom-agent-identity-reconcile-v1.json';
const RECEIPT_CONTENTS = '{"version":1,"kind":"legacy-custom-agent-identity-reconcile"}\n';
/** Durable one-shot gate for legacy Custom-Agent identity recovery. */
export class LegacyCustomAgentIdentityReceipt {
    dataDir;
    constructor(dataDir) {
        this.dataDir = dataDir;
    }
    async isCompleted() {
        try {
            return (await readFile(this.path(), 'utf8')) === RECEIPT_CONTENTS;
        }
        catch (error) {
            if (isNotFound(error))
                return false;
            throw error;
        }
    }
    async complete() {
        const outcome = await publishFileIfAbsent(this.path(), RECEIPT_CONTENTS, async (temporaryPath) => {
            if ((await readFile(temporaryPath, 'utf8')) !== RECEIPT_CONTENTS) {
                throw new Error('Legacy Custom Agent identity receipt validation failed');
            }
        });
        if (outcome === 'already-exists' && !(await this.isCompleted())) {
            throw new Error('Legacy Custom Agent identity receipt is invalid');
        }
    }
    path() {
        return join(this.dataDir, 'v2', 'migration', 'manifests', RECEIPT_FILE);
    }
}
function isNotFound(error) {
    return error?.code === 'ENOENT';
}
//# sourceMappingURL=legacy-custom-identity-receipt.js.map