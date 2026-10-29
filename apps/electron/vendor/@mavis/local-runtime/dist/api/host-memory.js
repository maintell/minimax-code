import { isLegacyMemoryRecallEnabled, isMemoryV2Enabled } from '@mavis/config';
import { SystemReminderService, createDefaultRegistry, withMcodeToolsMasterReminder, } from '@mavis/system-reminder';
import { logger } from '../common/logger.js';
import { LocalDataCollector, } from '../memory/local-data-collector.js';
import { LocalMemoryFacade } from '../memory/local-memory-facade.js';
import { v1AutoMemoryWritesStopped, } from '../memory/local-memory-orchestration.js';
/**
 * Per-turn reminder clock: `Date#toString()` without seconds (e.g.
 * `Fri Oct 09 2026 13:20 GMT+0800 (China Standard Time)`). Minute precision
 * keeps the zone/offset the model relies on while avoiding a value that is
 * unique to every second.
 */
export function formatReminderDate(nowMs) {
    return new Date(nowMs).toString().replace(/(\d{2}:\d{2}):\d{2}/u, '$1');
}
export function createLocalMemorySubsystem(input) {
    const memoryFacade = new LocalMemoryFacade({
        config: () => ({
            dataDir: input.configGetter().dataDir,
            enabled: input.configGetter().memory?.enabled !== false &&
                !isMemoryV2Enabled(input.configGetter().memory),
            agentMemoryRetired: isMemoryV2Enabled(input.configGetter().memory),
        }),
        nowMs: input.nowMs,
        emitBusEvent: input.emitBusEvent,
    });
    const localDataCollector = new LocalDataCollector(memoryFacade, {
        dataDir: () => input.configGetter().dataDir,
        memoryEnabled: () => input.configGetter().memory?.enabled !== false &&
            !isMemoryV2Enabled(input.configGetter().memory),
        memoryRecallEnabled: (agentName) => isLegacyMemoryRecallEnabled(input.configGetter().memory, agentName),
        ...(input.userMemoryEnabled ? { userMemoryEnabled: input.userMemoryEnabled } : {}),
        ...(input.cronEnabled ? { cronEnabled: input.cronEnabled } : {}),
        proactiveMemoryEnabled: () => {
            const memory = input.configGetter().memory;
            return (memory?.enabled !== false &&
                memory?.proactive === true &&
                // V2 接管后停止旧版主动记忆。
                !v1AutoMemoryWritesStopped(memory));
        },
        memoryAutoWriteEnabled: () => !v1AutoMemoryWritesStopped(input.configGetter().memory),
        formatDate: () => formatReminderDate(input.nowMs()),
        emitBusEvent: input.emitBusEvent,
        nowMs: input.nowMs,
        ...(input.cliSunsetNotice ? { cliSunsetNotice: input.cliSunsetNotice } : {}),
        agentFacts: input.agentFacts,
        userConfiguredName: input.userConfiguredName,
    });
    const systemReminderService = new LocalSystemReminderService(localDataCollector, input.configGetter, input.emitBusEvent);
    return { memoryFacade, localDataCollector, systemReminderService };
}
export class LocalSystemReminderService {
    collector;
    configGetter;
    emitBusEvent;
    service;
    constructor(collector, configGetter, emitBusEvent) {
        this.collector = collector;
        this.configGetter = configGetter;
        this.emitBusEvent = emitBusEvent;
        const srLogger = {
            warn: (ctx, msg) => logger.warn({ ...ctx }, msg),
            info: (ctx, msg) => logger.info({ ...ctx }, msg),
            error: (ctx, msg) => logger.error({ ...ctx }, msg),
        };
        const registry = createDefaultRegistry((ts) => new Date(ts).toString());
        this.service = new SystemReminderService(this.collector, registry, this.configGetter().dataDir, srLogger, () => ({ traceId: 'local-runtime-system-reminder' }), { disableModelPrefixes: [] });
    }
    async buildReminder(session, msg, options) {
        const beta = this.configGetter().beta;
        const result = await this.service.buildReminder(session, msg, options?.withDiagnostic ? { withDiagnostic: true } : undefined);
        const text = withMcodeToolsMasterReminder({
            reminderText: result.text,
            modelID: msg.model?.modelID,
            enabled: beta?.mcodeTools === true &&
                (options?.availableSkillNames === undefined ||
                    options.availableSkillNames.includes('mcode-tools-master')),
        }) ?? '';
        const memoryBlockNames = extractMemoryBlockNames(text);
        const finalizeTelemetry = once((input) => this.recordSystemReminderTelemetry({
            sessionId: session.sessionId,
            turnId: msg.turnId,
            agentName: session.agentName,
            ...input,
        }));
        if (!options?.deferTelemetry)
            finalizeTelemetry({ text, diagnostic: result.diagnostic });
        this.emitBusEvent?.(memoryBlockNames.length > 0 ? 'memory.provider_injected' : 'memory.provider_skipped', {
            sessionId: session.sessionId,
            turnId: msg.turnId,
            agentName: session.agentName,
            blockNames: memoryBlockNames,
            blockCount: memoryBlockNames.length,
            ...(memoryBlockNames.length > 0 ? {} : { reason: 'no_blocks' }),
        });
        const deferredTelemetry = options?.deferTelemetry ? { finalizeTelemetry } : {};
        if (!options?.withDiagnostic)
            return { text, ...deferredTelemetry };
        return {
            text,
            ...deferredTelemetry,
            ...(result.diagnostic
                ? { diagnostic: { ...result.diagnostic, fullText: text || null } }
                : {}),
        };
    }
    recordSystemReminderTelemetry(input) {
        this.emitBusEvent?.(input.text ? 'system_reminder.injected' : 'system_reminder.skipped', {
            ...readSystemReminderEventAttributes(input.diagnostic),
            sessionId: input.sessionId,
            turnId: input.turnId,
            agentName: input.agentName,
            ...(input.text ? { bytes: Buffer.byteLength(input.text, 'utf8') } : { reason: 'no_blocks' }),
        });
    }
}
function once(callback) {
    let called = false;
    return (input) => {
        if (called)
            return;
        called = true;
        callback(input);
    };
}
const RESERVED_SYSTEM_REMINDER_EVENT_ATTRIBUTES = new Set([
    'agentName',
    'bytes',
    'reason',
    'sessionId',
    'turnId',
]);
function readSystemReminderEventAttributes(diagnostic) {
    if (!isRecord(diagnostic))
        return {};
    const eventAttributes = diagnostic.eventAttributes;
    if (!isRecord(eventAttributes))
        return {};
    const accepted = {};
    for (const [key, value] of Object.entries(eventAttributes)) {
        if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(key) ||
            RESERVED_SYSTEM_REMINDER_EVENT_ATTRIBUTES.has(key)) {
            continue;
        }
        if (typeof value === 'boolean' ||
            typeof value === 'string' ||
            (typeof value === 'number' && Number.isFinite(value))) {
            accepted[key] = value;
        }
    }
    return accepted;
}
function isRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function extractMemoryBlockNames(text) {
    const memoryBlockNameByTag = new Map([
        ['agent_memory_update', 'agent_memory_update'],
        ['user_memory_update', 'user_memory_update'],
        ['memory_summary_update', 'memory_summary_update'],
        ['daily_memory_update', 'daily_memory_update'],
        ['proactive-memory', 'proactive_memory'],
    ]);
    return [...text.matchAll(/<([a-z_-]+)>/gu)]
        .map((match) => memoryBlockNameByTag.get(match[1]))
        .filter((name) => name !== undefined);
}
//# sourceMappingURL=host-memory.js.map