import { MemoryExecutionLedger } from './execution/ledger.js';
import { MemoryDiagnostics, traceMemoryPort } from './diagnostics.js';
import { GLOBAL_SCOPE_KEY } from './contracts.js';
import { accessPolicy } from './access-policy.js';
import { MemoryCaptureService } from './orchestration/capture-service.js';
import { MemoryConsolidationService } from './orchestration/consolidation-service.js';
import { MemoryGovernanceService } from './orchestration/governance-service.js';
import { MemoryLegacyMigrationService } from './orchestration/legacy-migration-service.js';
import { MemoryRecallService } from './orchestration/recall-service.js';
import { MemoryReconciler } from './orchestration/reconciler.js';
import { MemoryScopeMutationCoordinator } from './scope-mutation.js';
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
        quotaRemainingPercent: () => options.model.quotaRemainingPercent(),
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
    // 3. 五个领域服务。它们只依赖 port 与互斥区，不依赖 Reconciler。
    const captureService = traceMemoryPort(diagnostics, 'capture', new MemoryCaptureService({ ...shared, model, nowMs }));
    const consolidationService = traceMemoryPort(diagnostics, 'consolidation', new MemoryConsolidationService({
        repository,
        fileStore,
        model,
        scopeMutation,
        config,
        nowMs,
    }));
    const recall = traceMemoryPort(diagnostics, 'recall', new MemoryRecallService(shared));
    const governance = traceMemoryPort(diagnostics, 'governance', new MemoryGovernanceService({ ...shared, nowMs }));
    const migrationService = traceMemoryPort(diagnostics, 'migration', new MemoryLegacyMigrationService({
        ...shared,
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
        rebuild: (...args) => execution.run({
            stage: 'consolidation',
            operation: 'rebuild',
            sourceRef: args[0],
        }, () => consolidationService.rebuild(...args)),
    };
    const legacyMigration = {
        prepare: (input) => execution.run({
            stage: 'migration',
            operation: 'prepare',
            sourceRef: input.agentName,
        }, () => migrationService.prepare(input)),
        accept: (input) => execution.run({
            stage: 'migration',
            operation: 'accept',
            sourceRef: input.agentName,
            previewId: input.previewId,
        }, () => migrationService.accept(input)),
        discard: migrationService.discard.bind(migrationService),
    };
    // 4. Reconciler 最后构造：它依赖全部领域服务，被依赖方一个都不认识它。
    const reconciler = new MemoryReconciler({
        repository,
        fileStore,
        source,
        capture,
        consolidation,
        governance,
        model,
        scopeMutation,
        config,
        nowMs,
        reportFailure: options.reportFailure,
        diagnostics,
    });
    // 5. 唯一的后置注入：把唤醒入口交回互斥区，构造期不成环。
    // 互斥区提交产生的是治理维护唤醒（§5.10）：只维护已有视图，不扫描抽取候选。
    scopeMutation.bindWakeSink(() => {
        reconciler.kick({ kind: 'maintenance' });
    });
    const agent = new MemoryAgentContributionAdapter(recall, governance);
    const turnObserver = traceMemoryPort(diagnostics, 'turnObserver', new MemoryTurnObserverAdapter(reconciler, source, diagnostics));
    return {
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
        reconciler,
        scopeMutation,
        agent,
        turnObserver,
        async ready() {
            await diagnostics.run('lifecycle.ready', { config: config() }, () => reconciler.ready());
        },
        async close() {
            // §5.10 的关闭序列：先停止接纳，再把已接纳的工作 drain 完。
            // 这里传一个永不 abort 的 signal —— 契约要求「已接纳的工作仍会被 drain 完成」，
            // 由调用方决定是否在外层加超时，而不是在这里单方面截断。
            await diagnostics.run('lifecycle.close', {}, async () => {
                reconciler.stopAdmission();
                await reconciler.drain(new AbortController().signal);
            });
            await diagnostics.flush();
        },
    };
}
//# sourceMappingURL=initialize.js.map