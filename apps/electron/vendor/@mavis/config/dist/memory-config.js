import { isMemoryV2Enabled } from '@mavis/shared/memory-version';
export { isMemoryV2Enabled } from '@mavis/shared/memory-version';
/** Memory V2 配置的唯一默认值；与设计 §2.3 同步。 */
export const MEMORY_V2_DEFAULTS = {
    enabled: false,
    detailedLoggingEnabled: false,
    writeEnabled: false,
    recallEnabled: false,
    eligibleSessionIdleMs: 6 * 60 * 60 * 1000,
    maxCaptureInputTokens: 64_000,
    maxSessionDocBytes: 64 * 1024,
    maxSelectedSessions: 256,
    maxConsolidationInputTokens: 256_000,
    maxMemoryMarkdownBytes: 2 * 1024 * 1024,
    maxSummaryInjectionTokens: 2_500,
    maxCaptureSessionsPerWake: 6,
    maxCaptureConcurrency: 2,
    eligibleSessionMaxAgeDays: 30,
    maxCaptureAttemptsPerRevision: 3,
    captureFailureBackoffMs: 60 * 60 * 1000,
    publicationCooldownMs: 6 * 60 * 60 * 1000,
    consolidationCron: undefined,
    maxConsolidationAgentTurns: 64,
    minModelQuotaRemainingPercent: 20,
    captureModel: undefined,
    captureReasoningEffort: 'low',
    consolidationModel: undefined,
    consolidationReasoningEffort: 'medium',
    retentionDays: 90,
};
// ── Memory config parsing ──────────────────────────────────────
/**
 * internal 与 inside 包默认启用 Memory V2（版本、写入与召回），作为灰度车道；其余渠道保持关闭。
 * 只替换缺省值：配置里显式写了 `v2_enabled` 或 `v2.enabled/writeEnabled/recallEnabled` 的用户
 * 仍按自己的选择解析，设置页关闭后不会被默认值重新打开。
 */
export function resolveMemoryDefaults(base, v2ByDefault) {
    if (!v2ByDefault)
        return base;
    return {
        ...base,
        v2_enabled: true,
        v2: { ...base.v2, writeEnabled: true, recallEnabled: true },
    };
}
export function parseMemoryConfig(raw, memoryDefaults) {
    const memoryRaw = raw.memory;
    const memoryObj = memoryRaw != null && typeof memoryRaw === 'object' && !Array.isArray(memoryRaw)
        ? memoryRaw
        : {};
    const dailyDigestRaw = memoryObj.dailyDigest;
    const dailyDigestObj = dailyDigestRaw != null && typeof dailyDigestRaw === 'object' && !Array.isArray(dailyDigestRaw)
        ? dailyDigestRaw
        : {};
    const v2Raw = memoryObj.v2;
    const v2Obj = v2Raw != null && typeof v2Raw === 'object' && !Array.isArray(v2Raw)
        ? v2Raw
        : {};
    const defaults = memoryDefaults.v2;
    const disabledAgents = memoryObj.legacyRecallDisabledAgents;
    return {
        legacyRecallDisabledAgents: disabledAgents && typeof disabledAgents === 'object' && !Array.isArray(disabledAgents)
            ? Object.fromEntries(Object.entries(disabledAgents).filter(([, value]) => typeof value === 'boolean'))
            : {},
        enabled: typeof memoryObj.enabled === 'boolean' ? memoryObj.enabled : memoryDefaults.enabled,
        proactive: typeof memoryObj.proactive === 'boolean' ? memoryObj.proactive : memoryDefaults.proactive,
        dailyDigest: {
            enabled: typeof dailyDigestObj.enabled === 'boolean'
                ? dailyDigestObj.enabled
                : memoryDefaults.dailyDigest.enabled,
        },
        v2_enabled: typeof memoryObj.v2_enabled === 'boolean' ||
            ['enabled', 'writeEnabled', 'recallEnabled'].some((key) => typeof v2Obj[key] === 'boolean')
            ? isMemoryV2Enabled(memoryObj)
            : isMemoryV2Enabled(memoryDefaults),
        v2: {
            ...(typeof v2Obj.enabled === 'boolean' ? { enabled: v2Obj.enabled } : {}),
            detailedLoggingEnabled: booleanOr(v2Obj.detailedLoggingEnabled, defaults.detailedLoggingEnabled),
            writeEnabled: booleanOr(v2Obj.writeEnabled, defaults.writeEnabled),
            recallEnabled: booleanOr(v2Obj.recallEnabled, defaults.recallEnabled),
            eligibleSessionIdleMs: positiveIntegerOr(v2Obj.eligibleSessionIdleMs, defaults.eligibleSessionIdleMs),
            maxCaptureInputTokens: positiveIntegerOr(v2Obj.maxCaptureInputTokens, defaults.maxCaptureInputTokens),
            maxSessionDocBytes: positiveIntegerOr(v2Obj.maxSessionDocBytes, defaults.maxSessionDocBytes),
            maxSelectedSessions: positiveIntegerOr(v2Obj.maxSelectedSessions, defaults.maxSelectedSessions),
            maxConsolidationInputTokens: positiveIntegerOr(v2Obj.maxConsolidationInputTokens, defaults.maxConsolidationInputTokens),
            maxMemoryMarkdownBytes: positiveIntegerOr(v2Obj.maxMemoryMarkdownBytes, defaults.maxMemoryMarkdownBytes),
            maxSummaryInjectionTokens: positiveIntegerOr(v2Obj.maxSummaryInjectionTokens, defaults.maxSummaryInjectionTokens),
            maxCaptureSessionsPerWake: positiveIntegerOr(v2Obj.maxCaptureSessionsPerWake, defaults.maxCaptureSessionsPerWake),
            maxCaptureConcurrency: positiveIntegerOr(v2Obj.maxCaptureConcurrency, defaults.maxCaptureConcurrency),
            eligibleSessionMaxAgeDays: positiveIntegerOr(v2Obj.eligibleSessionMaxAgeDays, defaults.eligibleSessionMaxAgeDays),
            maxCaptureAttemptsPerRevision: positiveIntegerOr(v2Obj.maxCaptureAttemptsPerRevision, defaults.maxCaptureAttemptsPerRevision),
            captureFailureBackoffMs: positiveIntegerOr(v2Obj.captureFailureBackoffMs, defaults.captureFailureBackoffMs),
            publicationCooldownMs: positiveIntegerOr(v2Obj.publicationCooldownMs, defaults.publicationCooldownMs),
            consolidationCron: typeof v2Obj.consolidationCron === 'string'
                ? v2Obj.consolidationCron.trim() || undefined
                : defaults.consolidationCron,
            maxConsolidationAgentTurns: positiveIntegerOr(v2Obj.maxConsolidationAgentTurns, defaults.maxConsolidationAgentTurns),
            minModelQuotaRemainingPercent: percentOr(v2Obj.minModelQuotaRemainingPercent, defaults.minModelQuotaRemainingPercent),
            captureModel: modelNameOr(v2Obj.captureModel, defaults.captureModel),
            captureReasoningEffort: reasoningEffortOr(v2Obj.captureReasoningEffort, defaults.captureReasoningEffort),
            consolidationModel: modelNameOr(v2Obj.consolidationModel, defaults.consolidationModel),
            consolidationReasoningEffort: reasoningEffortOr(v2Obj.consolidationReasoningEffort, defaults.consolidationReasoningEffort),
            retentionDays: positiveIntegerOr(v2Obj.retentionDays, defaults.retentionDays),
        },
    };
}
function booleanOr(value, fallback) {
    return typeof value === 'boolean' ? value : fallback;
}
function positiveIntegerOr(value, fallback) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
function percentOr(value, fallback) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 100
        ? value
        : fallback;
}
function modelNameOr(value, fallback) {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
}
function reasoningEffortOr(value, fallback) {
    return value === 'low' || value === 'medium' || value === 'high' ? value : fallback;
}
/** V2 接管后，旧 Agent 记忆退出召回。 */
export function isLegacyMemoryRecallEnabled(memory, agentName) {
    return (!isMemoryV2Enabled(memory) &&
        memory?.enabled !== false &&
        memory?.legacyRecallDisabledAgents?.[agentName] !== true);
}
//# sourceMappingURL=memory-config.js.map