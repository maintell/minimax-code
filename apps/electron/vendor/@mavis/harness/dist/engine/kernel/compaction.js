import { projectTurnRequestContext } from '../../agent-host/execution/ptc/compaction-reminder.js';
import { CheckpointImageFileWriter, createContextCompactors, createMainRequestProjection, } from '../../compaction/index.js';
import { withModelCredentials } from './model-credential.js';
/** Compactors of one run plus the Host's Session-side compaction effects. */
export function createCompactionDependencies(dependencies, scope, state) {
    const { compaction, observability } = dependencies;
    const { agent, artifacts } = scope;
    const host = scope.host.compaction;
    return {
        ...createContextCompactors({
            checkpointRequestMessages: compaction.checkpointRequestMessages,
            mainRequestMessages: createRunMainRequestProjection(scope).project,
            checkpointReminder: host.checkpointReminder,
            contextUsageAnchor: state.usageAnchor,
            checkpointState: host.checkpointState,
            logger: observability?.logger,
            imageFileWriter: new CheckpointImageFileWriter({
                writeImageArtifact: (input) => artifacts.writeImage(input),
                logger: observability?.logger,
            }),
            promptSnapshots: agent.promptSnapshots,
            resolveEarlierFiles: artifacts.resolveEarlierFiles,
            getCompactionTriggerAt: state.compactionTriggerAt,
        }),
        preparation: withModelCredentials(agent.preparation, scope.model),
        control: host.control,
        ...state.compactionMetrics.wrap({ lifecycle: host.lifecycle, observer: host.observer }, observability?.metricsClient, dependencies.policy.nowMs ?? Date.now),
        barrier: host.barrier,
        checkpointSharedPrefixEnabled: compaction.checkpointSharedPrefixEnabled,
        metricsClient: observability?.metricsClient,
        usageAnchor: state.usageAnchor,
        segments: host.segments,
    };
}
/**
 * The main request's request-only steps after compaction: the Turn's request
 * context, the Host's Session filter, then the media guard. The shared-prefix
 * checkpoint request repeats the same projection.
 */
export function createRunMainRequestProjection(scope) {
    return createMainRequestProjection(scope.host.compaction.requestMessages, projectTurnRequestContext);
}
//# sourceMappingURL=compaction.js.map