import { createHash } from 'node:crypto';
const BASELINE_MESSAGE = {
    role: 'user',
    content: [{ type: 'text', text: '.' }],
    timestamp: 0,
};
const DEFAULT_RETRY_COOLDOWN_MS = 60_000;
/**
 * Process-local Context Usage calibration state.
 *
 * It is intentionally not a domain store: no persistence, API, database row,
 * or UI identity is introduced. Tool marginals are reused only while the
 * provider/model/tool-definition fingerprint stays byte-identical.
 */
export class ContextUsageCalibrationCoordinator {
    counter;
    nowMs;
    retryCooldownMs;
    toolCalibrations = new Map();
    constructor(counter, options = {}) {
        this.counter = counter;
        this.nowMs = options.nowMs ?? (() => Date.now());
        this.retryCooldownMs = options.retryCooldownMs ?? DEFAULT_RETRY_COOLDOWN_MS;
    }
    async calibrateTools(input) {
        const tools = [...(input.context.tools ?? [])];
        const fingerprint = buildToolFingerprint(input.model, tools);
        if (tools.length === 0) {
            return { fingerprint, status: 'EMPTY', tokens: 0 };
        }
        const now = this.nowMs();
        const cached = this.toolCalibrations.get(fingerprint);
        if (cached?.result?.status === 'REMOTE')
            return cached.result;
        if (cached?.pending)
            return cached.pending;
        if ((cached?.retryAfterMs ?? 0) > now) {
            return cached?.result ?? { fingerprint, status: 'UNAVAILABLE' };
        }
        const pending = this.refreshToolCalibration({ ...input, fingerprint });
        this.toolCalibrations.set(fingerprint, { pending });
        return pending;
    }
    /**
     * Read a completed Tool calibration without starting a Provider request.
     * Manual compaction uses this to keep its immediate local-only Snapshot on
     * the same Tool scale as the preceding generated turn.
     */
    getCachedToolCalibration(input) {
        const tools = [...(input.context.tools ?? [])];
        const fingerprint = buildToolFingerprint(input.model, tools);
        if (tools.length === 0) {
            return { fingerprint, status: 'EMPTY', tokens: 0 };
        }
        const result = this.toolCalibrations.get(fingerprint)?.result;
        return result?.status === 'REMOTE' ? result : undefined;
    }
    getToolFingerprint(input) {
        return buildToolFingerprint(input.model, input.context.tools ?? []);
    }
    async refreshToolCalibration(input) {
        let result;
        try {
            result = await this.countToolMarginal(input);
        }
        catch {
            result = { fingerprint: input.fingerprint, status: 'UNAVAILABLE' };
        }
        this.toolCalibrations.set(input.fingerprint, result.status === 'REMOTE'
            ? { result }
            : { result, retryAfterMs: this.nowMs() + this.retryCooldownMs });
        return result;
    }
    async countToolMarginal(input) {
        const base = {
            messages: [BASELINE_MESSAGE],
            model: input.model,
            ...(input.context.systemPrompt ? { systemPrompt: input.context.systemPrompt } : {}),
            ...buildCalibrationStreamOptions(input.streamOptions),
        };
        // Probe without tools first. An unavailable counter cannot calibrate the
        // marginal, so do not upload the much larger tool definitions in that case.
        const withoutTools = await this.counter.countContextTokens(base);
        if (withoutTools.source !== 'remote') {
            return { fingerprint: input.fingerprint, status: 'UNAVAILABLE' };
        }
        const withTools = await this.counter.countContextTokens({
            ...base,
            tools: [...(input.context.tools ?? [])],
        });
        const tokens = withTools.tokens - withoutTools.tokens;
        if (withTools.source !== 'remote' || !Number.isSafeInteger(tokens) || tokens < 0) {
            return { fingerprint: input.fingerprint, status: 'UNAVAILABLE' };
        }
        return {
            fingerprint: input.fingerprint,
            status: 'REMOTE',
            tokens,
        };
    }
}
function buildCalibrationStreamOptions(options = {}) {
    return {
        ...(options.apiKey ? { apiKey: options.apiKey } : {}),
        ...(options.headers ? { headers: options.headers } : {}),
        ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
        ...(options.cacheRetention ? { cacheRetention: options.cacheRetention } : {}),
        ...(options.reasoning ? { thinkingLevel: options.reasoning } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
    };
}
function buildToolFingerprint(model, tools) {
    const serialized = safeJsonStringify({
        provider: model.provider,
        api: model.api,
        model: model.id,
        baseUrl: model.baseUrl,
        tools,
    });
    return createHash('sha256').update(serialized).digest('hex');
}
function safeJsonStringify(value) {
    try {
        return JSON.stringify(value) ?? '';
    }
    catch {
        return '[unserializable]';
    }
}
//# sourceMappingURL=context-usage-calibration.js.map