import { logger } from '@mavis/shared/local-runtime-logging';
import { MemoryExecutionLedger } from './execution/ledger.js';
import { MemoryDiagnostics, traceMemoryPort } from './diagnostics.js';
import { GLOBAL_SCOPE_KEY } from './contracts.js';
import { accessPolicy } from './policies/access-policy.js';
import { MemoryCaptureService } from './orchestration/capture-service.js';
import { MemoryConsolidationService } from './orchestration/consolidation-service.js';
import { MemoryGovernanceService } from './orchestration/governance-service.js';
import { MemoryLegacyMigrationService } from './orchestration/legacy-migration-service.js';
import { MemoryRecallService } from './orchestration/recall-service.js';
import { MemoryReconciler } from './orchestration/reconciler.js';
import { MemoryScopeMutationCoordinator, MemorySummaryEditorImpl, } from './policies/scope-mutation.js';
import { MemoryOnboardingStore } from './onboarding.js';
import { MemoryRolloutGate } from './rollout.js';
import { MemoryAgentContributionAdapter } from './adapters/agent-contribution.js';
import { MemoryFileStoreImpl } from './adapters/file-store.js';
import { MemoryStateRepositoryImpl } from './adapters/state-repository.js';
import { MemoryTurnObserverAdapter } from './adapters/turn-observer.js';
export function initializeMemorySystem(options) {
    const nowMs = options.nowMs ?? (() => Date.now());
    const config = options.config;
    const execution = options.execution ?? new MemoryExecutionLedger(options.db, nowMs);
    // 1. 两个介质 port。彼此不知道对方存在（§2.1 内容与状态分工）。
    const diagnostics = options.diagnostics ??
        new MemoryDiagnostics({
            dataDir: options.dataDir,
            enabled: () => config().detailedLoggingEnabled,
            nowMs,
        });
    const repository = traceMemoryPort(diagnostics, 'repository', new MemoryStateRepositoryImpl(options.db, nowMs));
    const fileStore = traceMemoryPort(diagnostics, 'files', new MemoryFileStoreImpl(options.dataDir));
    const source = traceMemoryPort(diagnostics, 'source', options.source);
    const model = traceMemoryPort(diagnostics, 'model', {
        readQuota: options.model.readQuota.bind(options.model),
        resolveContract: options.model.resolveContract.bind(options.model),
        capture: (input) => options.model.capture(input),
        consolidateInPlace: (input) => options.model.consolidateInPlace(input),
        migrateLegacy: (input) => execution.withSource(input.source.sourceFile, () => options.model.migrateLegacy(input)),
    });
    // 2. 写入互斥区。无业务语义，不触发任何工作（§5.11）。
    const scopeMutation = new MemoryScopeMutationCoordinator();
    const shared = {
        accessPolicy,
        repository,
        fileStore,
        source,
        scopeMutation,
        config,
    };
    // Turn 观察者依赖 Reconciler，而 Reconciler 依赖治理服务；用持有者回填打破构造环。
    const rootInputTurns = {};
    // 3. 五个领域服务。它们只依赖 port 与互斥区，不依赖 Reconciler。
    const captureService = traceMemoryPort(diagnostics, 'capture', new MemoryCaptureService({ ...shared, model, nowMs }));
    const consolidationService = traceMemoryPort(diagnostics, 'consolidation', new MemoryConsolidationService({ ...shared, model, nowMs, diagnostics }));
    const recall = traceMemoryPort(diagnostics, 'recall', new MemoryRecallService(shared));
    const governance = traceMemoryPort(diagnostics, 'governance', new MemoryGovernanceService({
        ...shared,
        model,
        isRootInputTurn: (s, t) => rootInputTurns.current?.isRootInputTurn(s, t) ?? false,
        nowMs,
        diagnostics,
    }));
    const onboardingStore = new MemoryOnboardingStore(options.db, repository, nowMs);
    const migrationService = traceMemoryPort(diagnostics, 'migration', new MemoryLegacyMigrationService({
        ...shared,
        onboarding: onboardingStore,
        modelGateway: model,
        disableLegacyRecall: options.disableLegacyRecall,
        nowMs,
    }));
    const capture = {
        inspect: captureService.inspect.bind(captureService),
        capture: (candidate) => execution.run({
            stage: 'capture',
            operation: 'capture',
            sourceRef: candidate.sessionId,
            sourceRevision: candidate.sourceRevision,
        }, () => captureService.capture(candidate)),
    };
    const consolidation = {
        inspect: consolidationService.inspect.bind(consolidationService),
        dropStaleCheckpoints: consolidationService.dropStaleCheckpoints.bind(consolidationService),
        discardCheckpoints: consolidationService.discardCheckpoints.bind(consolidationService),
        rebuild: (...args) => execution.run({
            stage: 'consolidation',
            operation: 'rebuild',
            sourceRef: args[0],
        }, () => consolidationService.rebuild(...args)),
    };
    const legacyMigration = {
        listPending: migrationService.listPending.bind(migrationService),
        abandon: migrationService.abandon.bind(migrationService),
        migrate: (candidate) => execution.run({
            stage: 'migration',
            operation: 'migrate',
            sourceRef: candidate.sourceFile,
            sourceRevision: candidate.sourceRevision,
        }, () => migrationService.migrate(candidate)),
    };
    const rollout = options.rollout &&
        createRolloutGate(options.rollout, {
            db: options.db,
            config,
            governance,
            onboarding: onboardingStore,
            // 完成入口在 Reconciler 之后定义，只在协调轮次中调用。
            completeOnboarding: (input) => completeOnboarding(input),
            nowMs,
            diagnostics,
        });
    /** 启动时的最低档判断不阻塞就绪；协调轮次与关闭都会等它结束。 */
    let startupPlanCheck;
    // 4. Reconciler 最后构造：它依赖全部领域服务，被依赖方一个都不认识它。
    const reconciler = new MemoryReconciler({
        repository,
        fileStore,
        source,
        capture,
        consolidation,
        governance,
        legacyMigration,
        model,
        scopeMutation,
        config,
        nowMs,
        reportFailure: options.reportFailure,
        diagnostics,
        ...(rollout ? { rollout } : {}),
    });
    const completeOnboarding = (input) => completeOnboardingWithMigration({ ...shared, onboarding: onboardingStore, reconciler }, input);
    // 5. 唯一的后置注入：把唤醒入口交回互斥区，构造期不成环。
    // 互斥区提交产生的是治理维护唤醒（§5.10）：只维护已有视图，不扫描抽取候选。
    scopeMutation.bindWakeSink(() => {
        reconciler.kick({ kind: 'maintenance' });
    });
    const turnAdapter = new MemoryTurnObserverAdapter(reconciler, source, diagnostics);
    rootInputTurns.current = turnAdapter;
    const turnObserver = traceMemoryPort(diagnostics, 'turnObserver', turnAdapter);
    const agent = new MemoryAgentContributionAdapter(recall, governance);
    return {
        summaryEditor: new MemorySummaryEditorImpl({
            dataDir: options.dataDir,
            repository,
            scopeMutation,
        }),
        executions: execution.query,
        async inspect(createdBeforeMs) {
            return diagnostics.run('inspection', { createdBeforeMs }, async () => ({
                createdBeforeMs,
                captures: await reconciler.inspectCaptures(createdBeforeMs, (candidate) => capture.inspect(candidate)),
                consolidation: await consolidation.inspect(GLOBAL_SCOPE_KEY),
            }), true);
        },
        recall,
        governance,
        legacyMigration,
        onboarding: {
            inspect: onboardingStore.inspect.bind(onboardingStore),
            markLegacySessionMigrated: onboardingStore.markLegacySessionMigrated.bind(onboardingStore),
            markLegacySessionAbandoned: onboardingStore.markLegacySessionAbandoned.bind(onboardingStore),
            markLegacyRecallDisabled: onboardingStore.markLegacyRecallDisabled.bind(onboardingStore),
            complete: (input) => completeOnboarding(input),
        },
        reconciler,
        scopeMutation,
        agent,
        turnObserver,
        async ready() {
            await openMemorySystem({ fileStore, diagnostics, reconciler, config });
            // 升级后只在启动时判断一次最低档默认值，结果持久化，之后不再判断。
            if (rollout)
                startupPlanCheck = rollout.settlePlanDefaults();
        },
        async close() {
            // §5.10 的关闭序列：先停止接纳，再把已接纳的工作 drain 完。
            // 这里传一个永不 abort 的 signal —— 契约要求「已接纳的工作仍会被 drain 完成」，
            // 由调用方决定是否在外层加超时，而不是在这里单方面截断。
            await diagnostics.run('lifecycle.close', {}, async () => {
                reconciler.stopAdmission();
                await reconciler.drain(new AbortController().signal);
                await startupPlanCheck;
            });
            await diagnostics.flush();
        },
    };
}
/**
 * 启动：先补救被旧版迁移清空的“关于你”，再开放协调准入。旧版迁移在用户资料迁完后会把
 * `memory/user.md` 写成空文件，原文留在迁移副本里；资料已有内容时不动，失败只记日志，不影响就绪。
 */
async function openMemorySystem(deps) {
    try {
        if (await deps.fileStore.restoreClearedUserProfile()) {
            logger.info({ file: 'memory/user.md' }, '[memory-v2] restored the user profile from its snapshot');
        }
    }
    catch (error) {
        logger.warn({ error: String(error) }, '[memory-v2] user profile restore failed');
    }
    await deps.diagnostics.run('lifecycle.ready', { config: deps.config() }, () => deps.reconciler.ready());
}
/** 选择迁移时立即记下起始纪元，之后的 Reset 让剩余迁移停止（§8.3）。 */
async function completeOnboardingWithMigration(deps, input) {
    const fresh = (await deps.onboarding.inspect()).record === undefined;
    if (!fresh || input.legacyChoice !== 'migrate')
        return deps.onboarding.complete(input);
    const scope = await deps.repository.ensureScope(GLOBAL_SCOPE_KEY);
    const result = await deps.onboarding.complete({
        ...input,
        legacyMigrationResetEpoch: scope.resetEpoch,
    });
    // 选择迁移后立即申请一轮迁移；未迁完的文件在后续任务唤醒中继续。
    if (result.status === 'completed')
        deps.reconciler.kick({ kind: 'legacy-migration' });
    return result;
}
/**
 * 正式版上线的一次性处理。全局作用域的 Reset 与设置页 Reset 共用治理服务的实现，不经会话解析。
 * 静默引导不删旧版迁移留下的用户资料副本，启动时还要用它恢复被清空的“关于你”；它本身在协调轮次中执行，因此不申请唤醒，
 * 文件清理失败由之后的协调轮次重试。
 */
function createRolloutGate(options, input) {
    const { governance } = input;
    return new MemoryRolloutGate({
        ...options,
        db: input.db,
        onboarding: input.onboarding,
        completeOnboarding: input.completeOnboarding,
        resetGlobalScope: async () => {
            await governance.resetScopeByKey(GLOBAL_SCOPE_KEY, {
                deleteLegacySnapshot: false,
                requestWakeOnComplete: false,
            });
        },
        config: input.config,
        nowMs: input.nowMs,
        event: (event, payload) => {
            input.diagnostics.event(event, payload);
        },
    });
}
//# sourceMappingURL=initialize.js.map