import { ComputerUseCaptureStore, sha256 } from './store.js';
export class ComputerUseCaptureReporter {
    store;
    config;
    identity;
    logger;
    pending = Promise.resolve();
    failure;
    prepared = false;
    sealed = false;
    calls = new Map();
    results = new Set();
    constructor(store, config, identity, logger) {
        this.store = store;
        this.config = config;
        this.identity = identity;
        this.logger = logger;
    }
    static async create(config, identity, logger) {
        const reporter = new ComputerUseCaptureReporter(await ComputerUseCaptureStore.create(config), config, identity, logger);
        reporter.enqueue('manifest', {
            ...identity,
            runId: config.runId,
            caseId: config.caseId,
            caseVersion: config.caseVersion,
            modelVersion: config.modelVersion,
            driverVersion: config.driverVersion,
            sdkVersion: config.sdkVersion,
            skillDigest: config.skillDigest,
            permissionMode: config.permissionMode,
            observationMode: config.observationMode,
            platform: process.platform,
            arch: process.arch,
            startedAtMs: Date.now(),
            integrity: 'incomplete',
            provenance: 'prepared_messages',
            providerWireVerified: false,
            upload: false,
            training: false,
            directorySyncSupported: process.platform !== 'win32',
        });
        for (const value of [
            config.modelVersion,
            config.driverVersion,
            config.sdkVersion,
            config.skillDigest,
            config.permissionMode,
            config.observationMode,
        ]) {
            if (!value?.trim())
                reporter.store.issues.add('missing_manifest_metadata');
        }
        await reporter.checkpoint();
        return reporter;
    }
    beginTurn(input) {
        // Never persist the reporter's apiKey or provider credentials.
        this.enqueue('begin_turn', {
            userMessage: input.userMessage,
            model: modelIdentity(input.model),
        });
    }
    reportSnapshot(input) {
        this.prepared = true;
        this.enqueue('prepared_messages', {
            messages: input.messages,
            systemPrompt: input.systemPrompt,
            phase: input.phase,
            model: modelIdentity(input.model),
            modelVersion: this.config.modelVersion,
            tools: input.tools,
            toolSchemaDigest: sha256(JSON.stringify(input.tools ?? [])),
            provenance: 'prepared_messages',
            providerWireVerified: false,
        });
    }
    reportToolCall(input) {
        if (!isComputerUseTool(input.toolName))
            return;
        if (this.calls.has(input.toolCallId))
            this.store.issues.add('duplicate_tool_call');
        if ([...this.calls.keys()].some((id) => !this.results.has(id))) {
            this.store.issues.add('previous_tool_result_not_checkpointed');
        }
        const args = input.args;
        this.calls.set(input.toolCallId, {
            name: input.toolName,
            expectsImage: args?.include_screenshot === true,
        });
        if (!this.prepared)
            this.store.issues.add('missing_prepared_messages');
        this.enqueue('tool_call', input);
    }
    reportToolResult(input) {
        if (!isComputerUseTool(input.toolName))
            return;
        const call = this.calls.get(input.toolCallId);
        if (!call || call.name !== input.toolName)
            this.store.issues.add('unpaired_tool_result');
        if (this.results.has(input.toolCallId))
            this.store.issues.add('duplicate_tool_result');
        this.results.add(input.toolCallId);
        // Pi may turn a thrown driver error into text and lose its completion provenance.
        if (input.isError)
            this.store.issues.add('tool_error');
        if (call?.expectsImage && !hasImage(input.result))
            this.store.issues.add('missing_image');
        this.enqueue('tool_result', { ...input, provenance: 'product_tool_result' });
    }
    reportAssistantMessage(input) {
        this.enqueue('assistant_message', { content: input.content, stopReason: input.stopReason });
    }
    reportUsage(input) {
        this.enqueue('usage', { usage: input.usage });
    }
    finishTurn(input) {
        this.enqueue('finish_turn', input);
    }
    /** Runs after the reporter callbacks, outside their ordinary fail-open wrapper. */
    withCheckpointHooks(hooks) {
        return {
            ...hooks,
            beforeToolCallHook: [
                ...(hooks.beforeToolCallHook ?? []),
                async (input) => {
                    if (!isComputerUseTool(input.toolCall.name))
                        return undefined;
                    await this.checkpoint();
                    if (this.config.strict)
                        await this.store.verifyAssets();
                    if (this.config.strict && (this.failure || this.store.issues.size)) {
                        return { block: true, terminateAgent: true, reason: 'computer_use_capture_incomplete' };
                    }
                    return undefined;
                },
            ],
            afterToolCallHook: [
                ...(hooks.afterToolCallHook ?? []),
                async (input) => {
                    if (isComputerUseTool(input.toolCall.name))
                        await this.checkpoint();
                    return undefined;
                },
            ],
        };
    }
    async seal() {
        if (this.sealed)
            return;
        this.sealed = true;
        await this.checkpoint();
        for (const id of this.calls.keys())
            if (!this.results.has(id))
                this.store.issues.add('missing_tool_result');
        await this.store.verifyAssets();
        if (this.failure)
            this.store.issues.add('persistence_failed');
        try {
            await this.store.append('seal', {
                ...this.identity,
                runId: this.config.runId,
                endedAtMs: Date.now(),
                integrity: this.store.issues.size ? 'incomplete' : 'complete',
                issues: [...this.store.issues],
                provenance: 'prepared_messages',
                providerWireVerified: false,
            });
        }
        catch (error) {
            this.failure = error;
        }
        this.finishIntegrityCheck();
    }
    finishIntegrityCheck() {
        if (this.failure || this.store.issues.size)
            this.reportIncomplete();
        if (this.config.strict && (this.failure || this.store.issues.size)) {
            throw new Error('computer_use_capture_incomplete');
        }
    }
    reportIncomplete() {
        try {
            this.logger?.warn?.({
                ...this.identity,
                issues: [...this.store.issues],
                persistenceFailed: Boolean(this.failure),
            }, '[computer-use-capture] local evidence incomplete');
        }
        catch {
            // Diagnostic failure must not replace capture admission or seal outcomes.
        }
    }
    enqueue(kind, payload) {
        if (this.sealed)
            return;
        let snapshot;
        try {
            snapshot = structuredClone(payload);
        }
        catch (error) {
            this.failure = error;
            return;
        }
        const previous = this.pending;
        this.pending = (async () => {
            try {
                await previous;
                if (this.failure)
                    return; // Stop extra collection on low space or other storage failure.
                await this.store.append(kind, {
                    ...this.identity,
                    runId: this.config.runId,
                    payload: snapshot,
                });
            }
            catch (error) {
                this.failure = error;
            }
        })();
    }
    async checkpoint() {
        await this.pending;
    }
}
export function isComputerUseTool(name) {
    return name.startsWith('computer_');
}
function modelIdentity(model) {
    if (!model || typeof model !== 'object')
        return undefined;
    const value = model;
    return { id: value.id, provider: value.provider, api: value.api };
}
function hasImage(value) {
    if (!value || typeof value !== 'object')
        return false;
    if (Array.isArray(value))
        return value.some(hasImage);
    const record = value;
    return record.type === 'image' || Object.values(record).some(hasImage);
}
//# sourceMappingURL=reporter.js.map