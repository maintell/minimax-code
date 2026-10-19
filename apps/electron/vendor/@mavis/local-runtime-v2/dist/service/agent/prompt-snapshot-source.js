import { isPromptSnapshotInvalidError, } from '../prompt-config/index.js';
/**
 * Adapts the local encrypted prompt store to the host-neutral runtime port.
 * The opaque runtime snapshot is only a WeakMap key; prompt storage metadata
 * remains local to this adapter.
 */
export class LocalPromptSnapshotSource {
    options;
    contexts = new WeakMap();
    constructor(options) {
        this.options = options;
    }
    async capture() {
        return this.snapshotFor(await this.options.config.capture());
    }
    async captureBuiltin() {
        return this.snapshotFor(await this.options.config.captureBuiltin());
    }
    async read(snapshot, key) {
        const context = this.contexts.get(snapshot);
        if (!context)
            throw new TypeError('Prompt snapshot was not captured by this source.');
        try {
            const content = await this.options.reader.read(context, key);
            if (content !== undefined)
                return { kind: 'found', content };
            return context.storageMode === 'encrypted' && this.options.managedKeys.has(key)
                ? { kind: 'invalid' }
                : { kind: 'missing' };
        }
        catch (error) {
            if (context.storageMode === 'encrypted' || isPromptSnapshotInvalidError(error)) {
                return { kind: 'invalid' };
            }
            throw error;
        }
    }
    snapshotFor(context) {
        const snapshot = Object.freeze({});
        this.contexts.set(snapshot, context);
        return snapshot;
    }
}
//# sourceMappingURL=prompt-snapshot-source.js.map