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
        const pending = this.countToolMarginal({
            context: input.context,
            model: input.model,
            streamOptions: input.streamOptions,
            fingerprint,
        })
            .catch(() => ({
            fingerprint,
            status: 'UNAVAILABLE',
        }))
            .then((result) => {
            this.toolCalibrations.set(fingerprint, result.status === 'REMOTE'
                ? { result }
                : { result, retryAfterMs: this.nowMs() + this.retryCooldownMs });
            return result;
        });
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
    async countToolMarginal(input) {
        const base = {
            messages: [BASELINE_MESSAGE],
            model: input.model,
            ...(input.context.systemPrompt ? { systemPrompt: input.context.systemPrompt } : {}),
            ...(input.streamOptions?.apiKey ? { apiKey: input.streamOptions.apiKey } : {}),
            ...(input.streamOptions?.headers ? { headers: input.streamOptions.headers } : {}),
            ...(input.streamOptions?.maxTokens !== undefined
                ? { maxTokens: input.streamOptions.maxTokens }
                : {}),
            ...(input.streamOptions?.cacheRetention
                ? { cacheRetention: input.streamOptions.cacheRetention }
                : {}),
            ...(input.streamOptions?.reasoning ? { thinkingLevel: input.streamOptions.reasoning } : {}),
            ...(input.streamOptions?.signal ? { signal: input.streamOptions.signal } : {}),
        };
        const [withoutTools, withTools] = await Promise.all([
            this.counter.countContextTokens(base),
            this.counter.countContextTokens({
                ...base,
                tools: [...(input.context.tools ?? [])],
            }),
        ]);
        const tokens = withTools.tokens - withoutTools.tokens;
        if (withoutTools.source !== 'remote' ||
            withTools.source !== 'remote' ||
            !Number.isSafeInteger(tokens) ||
            tokens < 0) {
            return { fingerprint: input.fingerprint, status: 'UNAVAILABLE' };
        }
        return {
            fingerprint: input.fingerprint,
            status: 'REMOTE',
            tokens,
        };
    }
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