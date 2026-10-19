const contextKeys = new WeakMap();
export function createPromptReadContext(input, key) {
    const context = Object.freeze({
        scopeId: input.scopeId,
        subject: input.subject,
        version: input.version,
        cacheId: input.cacheId,
        directory: input.directory,
        storageMode: input.storageMode,
        keyVersion: input.keyVersion,
    });
    if (key)
        contextKeys.set(context, Buffer.from(key));
    return context;
}
export function keyForPromptReadContext(context) {
    return contextKeys.get(context);
}
//# sourceMappingURL=read-context.js.map