import { MemoryExecutionLedger } from './execution/ledger.js';
import { MemoryDiagnostics, traceMemoryPort } from './diagnostics.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readPromptWithBuiltinFallback } from '../agent/index.js';
import { resolveBuiltinPromptAssetsDir } from '../prompt-config/index.js';
import { createGlobalMemoryModelCompletion, } from '../turn-system/index.js';
import { createMemoryAgentExtension, createMemorySessionDeletionHook, } from './adapters/runtime-bridge.js';
import { resolveMemorySystemConfig, resolveMemoryV2Config } from './config.js';
import { initializeMemorySystem } from './initialize.js';
import { MemoryV2ModelGateway } from './adapters/model-gateway.js';
import { SessionMemorySourceAdapter } from './adapters/session-source.js';
import { MemorySubscriptionQuota, } from './adapters/quota/subscription-quota.js';
import { createProductionSessionSystemPort, } from './adapters/session-source.production.js';
/** kind 与 `assets/agents/memory-v2-*.md` 的固定对应。 */
const PROMPT_ASSETS = {
    capture: 'memory-v2-extraction.md',
    consolidation: 'memory-v2-consolidation.md',
    migration: 'memory-v2-migration.md',
};
export function initializeProductionMemoryV2System(input) {
    const nowMs = input.nowMs ?? (() => Date.now());
    const config = () => resolveMemoryV2Config(input.appConfig());
    const execution = new MemoryExecutionLedger(input.db, nowMs);
    const diagnostics = new MemoryDiagnostics({
        dataDir: input.dataDir,
        enabled: () => config().detailedLoggingEnabled,
        nowMs,
    });
    const source = new SessionMemorySourceAdapter(createProductionSessionSystemPort({
        sessions: input.sessions,
        projects: input.projects,
        history: input.history,
        nowMs,
    }));
    const readPrompt = (kind) => input.readPrompt(PROMPT_ASSETS[kind]);
    const quota = input.quota ? new MemorySubscriptionQuota({ ...input.quota, nowMs }) : undefined;
    const model = new MemoryV2ModelGateway({
        readSubscriptionQuota: quota ? (modelName) => quota.read(modelName) : undefined,
        config,
        readPrompt,
        completion: traceMemoryPort(diagnostics, 'completion', createGlobalMemoryModelCompletion({
            preparation: input.preparation,
            defaultModelName: input.defaultModelName,
            nowMs,
            diagnosticEvent: (event, payload) => diagnostics.event(event, payload),
            modelCalls: execution.modelCalls,
        })),
    });
    return initializeMemorySystem({
        disableLegacyRecall: input.disableLegacyRecall,
        db: input.db,
        dataDir: input.dataDir,
        source,
        config,
        model,
        diagnostics,
        execution,
        nowMs,
    });
}
/** 读取受控 Prompt 资产，优先用线上快照，回落到内置文件。 */
async function readMemoryPromptAsset(key, source) {
    const builtinAssetsDir = await resolveBuiltinPromptAssetsDir();
    const builtin = await readFile(join(builtinAssetsDir, key), 'utf8');
    return readPromptWithBuiltinFallback({ ...(source ? { source } : {}), key, builtin });
}
/**
 * Runtime 侧入口，入参形状与 `services.ts` 现有装配保持一致。
 *
 * 未启用 channel 时返回 undefined，与旧实现的短路行为一致；Memory V2 自身的
 * 读写开关由 §2.3 的 `writeEnabled` / `recallEnabled` 控制，默认关闭。
 */
export function initializeRuntimeMemoryV2System(input) {
    if (!input.enableChannel)
        return undefined;
    const memory = () => input.product.preparation.configBuilder.config().memory;
    // 沿用配置分支缺失时跳过装配的行为；显式版本选择也可使用默认功能参数。
    if (!memory()?.v2 && memory()?.v2_enabled === undefined)
        return undefined;
    const appConfig = () => resolveMemorySystemConfig(memory());
    const system = initializeProductionMemoryV2System({
        quota: input.quota,
        disableLegacyRecall: input.options.compatibility.memoryMigration.disableLegacyRecall,
        db: input.options.db,
        dataDir: input.options.dataDir,
        sessions: input.sessionSystem.repositories.sessions,
        projects: input.sessionSystem.repositories.projects,
        history: input.sessionSystem.canonicalHistory,
        preparation: input.preparation,
        appConfig,
        defaultModelName: () => input.product.preparation.configBuilder.config().defaultModel ?? 'minimax/MiniMax-M3',
        readPrompt: (key) => readMemoryPromptAsset(key, input.product.promptSnapshots),
        nowMs: input.nowMs,
    });
    return {
        ...system,
        // 唤醒与引用记账都由扩展承载（turn_start / after_llm_call，§5.10、§5.7）。
        agentExtension: createMemoryAgentExtension(system.agent, system.turnObserver, input.nowMs),
        sessionDeletion: createMemorySessionDeletionHook(system.governance),
    };
}
//# sourceMappingURL=production.js.map