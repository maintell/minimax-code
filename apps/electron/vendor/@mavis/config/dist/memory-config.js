import { explicitMemoryVersion, isMemoryV2Enabled, } from '@mavis/shared/memory-version';
export { isMemoryV2Enabled } from '@mavis/shared/memory-version';
/**
 * Memory V2 功能参数的基础缺省值，与设计 §2.3 同步。生成与使用在这里是关闭的：领域服务直接装配
 * （`resolveMemoryV2Config`）时沿用显式启用语义。应用解析配置时的缺省值见 config.ts 的 `DEFAULTS.memory`：
 * 所有渠道缺省 V2，生成与使用开启。
 */
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
    maxConsolidationAgentTurns: 128,
    minModelQuotaRemainingPercent: 20,
    captureModel: undefined,
    captureReasoningEffort: 'low',
    consolidationModel: undefined,
    consolidationReasoningEffort: 'medium',
    retentionDays: 90,
};
// ── Memory config parsing ──────────────────────────────────────
/**
 * 显式选择 V2、生成与使用都关闭的字段。新安装、升级前已关闭旧版记忆的迁移和最低档账号的关闭都写这一组。
 * 没写版本时缺省也是 V2，这里仍显式写出版本，不依赖缺省值。
 */
const MEMORY_V2_OFF = {
    v2_enabled: true,
    v2: { writeEnabled: false, recallEnabled: false },
};
/** 同一组字段写成 `updateConfig` 的点路径补丁，供 Runtime 写配置时使用。 */
export function memoryV2OffConfigUpdates() {
    const updates = { 'memory.v2_enabled': MEMORY_V2_OFF.v2_enabled };
    for (const [key, value] of Object.entries(MEMORY_V2_OFF.v2))
        updates[`memory.v2.${key}`] = value;
    return updates;
}
/** 新安装写入的记忆配置：旧版总开关关闭，并写入 `MEMORY_V2_OFF`。 */
export function freshInstallMemoryConfig() {
    return { enabled: false, v2_enabled: MEMORY_V2_OFF.v2_enabled, v2: { ...MEMORY_V2_OFF.v2 } };
}
/**
 * 升级前关闭了旧版记忆（`memory.enabled: false`），也从未选择过版本（`explicitMemoryVersion` 为
 * undefined）。切到 V2 后这类配置保持关闭；解析与写盘迁移共用这一判断。
 */
function isLegacyOffWithoutVersion(memoryObj) {
    return memoryObj.enabled === false && explicitMemoryVersion(memoryObj) === undefined;
}
/**
 * 升级前关闭了旧版记忆、也从未选择过版本的配置，切到 V2 后保持关闭：显式选择 V2，并把生成与使用写成关闭；
 * `v2` 不是对象时是无效值，同样按空对象处理并覆盖。写入后配置带有显式版本，条件不再成立，因此只会生效一次。
 * 返回值表示 `raw` 是否被修改。
 */
export function migrateLegacyMemoryOffToV2(raw) {
    const memoryObj = plainObject(raw.memory);
    if (!memoryObj || !isLegacyOffWithoutVersion(memoryObj))
        return false;
    memoryObj.v2_enabled = MEMORY_V2_OFF.v2_enabled;
    memoryObj.v2 = { ...(plainObject(memoryObj.v2) ?? {}), ...MEMORY_V2_OFF.v2 };
    return true;
}
export function parseMemoryConfig(raw, memoryDefaults) {
    const memoryObj = plainObject(raw.memory) ?? {};
    const dailyDigestObj = plainObject(memoryObj.dailyDigest) ?? {};
    const v2Obj = plainObject(memoryObj.v2) ?? {};
    // 旧版记忆关闭且从未选择过版本：解析时生成与使用同样缺省关闭，写盘迁移失败或外部配置文件也不会被缺省值打开。
    const defaults = isLegacyOffWithoutVersion(memoryObj)
        ? { ...memoryDefaults.v2, ...MEMORY_V2_OFF.v2 }
        : memoryDefaults.v2;
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
        // 版本只认配置自己的选择；没有时取缺省版本，所有渠道都是 V2。
        v2_enabled: explicitMemoryVersion(memoryObj) ?? isMemoryV2Enabled(memoryDefaults),
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
function plainObject(value) {
    return value != null && typeof value === 'object' && !Array.isArray(value)
        ? value
        : undefined;
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