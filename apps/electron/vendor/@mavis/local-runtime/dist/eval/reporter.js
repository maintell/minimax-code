import { logger } from '../common/logger.js';
import { recordMetaInfoPayload } from './metrics.js';
import { buildLocalEvalMetaInfoStep, buildLocalTrajectoryId, buildReportEvalStepBodies, collectSensitiveValues, describeModel, maskText, safeJsonStringify, truncateUtf8, } from './payload.js';
import { buildLocalEvalSnapshotRequest } from './snapshot.js';
import { collectLocalEvalSessionMetadata } from './session-metadata.js';
const MAX_BATCH_STEPS = 16;
const MAX_REPORT_BODY_BYTES = 6 << 20;
export class LocalEvalReporter {
    factory;
    context;
    nowMs;
    maxStepFieldBytes;
    maxSnapshotBytes;
    metricsClient;
    trajectoryId;
    sensitiveValues = new Set();
    pendingSteps = [];
    pendingSessionMetadata;
    sessionMetadata;
    batchTimer;
    turnId = '';
    startedTurn = false;
    oversizedSnapshotTurnId;
    targetModel;
    metaInfoQueued = false;
    constructor(factory, context, nowMs, maxStepFieldBytes, maxSnapshotBytes, metricsClient) {
        this.factory = factory;
        this.context = context;
        this.nowMs = nowMs;
        this.maxStepFieldBytes = maxStepFieldBytes;
        this.maxSnapshotBytes = maxSnapshotBytes;
        this.metricsClient = metricsClient;
        this.trajectoryId = buildLocalTrajectoryId(context.sessionId);
        this.sessionMetadata = collectLocalEvalSessionMetadata(context);
        this.pendingSessionMetadata = this.sessionMetadata;
    }
    refreshSessionFields(context) {
        this.sessionMetadata = collectLocalEvalSessionMetadata(context);
    }
    hasActiveTurn() {
        return this.turnId.length > 0;
    }
    hasFinishedTurn() {
        return this.startedTurn && !this.hasActiveTurn();
    }
    beginTurn(input) {
        this.startedTurn = true;
        this.turnId = input.turnId;
        this.oversizedSnapshotTurnId = undefined;
        this.targetModel = describeModel(input.model);
        collectSensitiveValues(input.model, this.sensitiveValues);
        if (input.apiKey && input.apiKey.length >= 6)
            this.sensitiveValues.add(input.apiKey);
        this.factory.drainRuntimeEvents(this.context.sessionId, this);
        this.reportSteps([
            {
                stepType: 'session_lifecycle',
                role: 'system',
                content: 'turn_started',
                rawJson: safeJsonStringify({ turn_id: input.turnId }, this.sensitiveValues),
            },
            {
                stepType: 'message',
                role: 'user',
                content: maskText(input.userMessage, this.sensitiveValues),
            },
        ], true);
        if (!this.metaInfoQueued && this.factory.canReport()) {
            this.metaInfoQueued = true;
            this.factory.enqueueMetaInfo(this, this.context.workspaceDir, this.sessionMetadata);
        }
    }
    reportSnapshot(input) {
        if (!this.turnId)
            return;
        if (this.oversizedSnapshotTurnId === input.turnId)
            return;
        const clientProducedTs = this.nowMs();
        const targetModel = describeModel(input.model) ?? this.targetModel;
        if (targetModel)
            this.targetModel = targetModel;
        const snapshot = buildLocalEvalSnapshotRequest({
            trajectoryId: this.trajectoryId,
            sessionId: this.context.sessionId,
            input,
            targetModel,
            clientProducedTs,
            seq: clientProducedTs * 1_000 + this.factory.nextStepIndex(clientProducedTs),
            sensitiveValues: this.sensitiveValues,
            maxBytes: this.maxSnapshotBytes,
        });
        if (snapshot.status === 'oversized') {
            this.oversizedSnapshotTurnId = input.turnId;
            logger.warn({
                sessionId: this.context.sessionId,
                turnId: input.turnId,
                atLeastBytes: snapshot.atLeastBytes,
                maxBytes: this.maxSnapshotBytes,
                messagesCount: input.messages.length,
            }, '[eval-capture] skipped oversized local snapshot');
            return;
        }
        if (snapshot.status === 'serialization_error') {
            logger.warn({
                sessionId: this.context.sessionId,
                turnId: input.turnId,
                error: snapshot.error.message,
            }, '[eval-capture] failed to serialize local snapshot request');
            return;
        }
        this.factory.enqueue(snapshot.request, this.context.sessionId);
    }
    reportLifecycle(event, details) {
        this.reportSteps([
            {
                stepType: 'session_lifecycle',
                role: 'system',
                content: event,
                ...(details ? { rawJson: safeJsonStringify(details, this.sensitiveValues) } : {}),
            },
        ]);
    }
    reportToolCall(input) {
        collectSensitiveValues(input.args, this.sensitiveValues);
        this.reportSteps([
            {
                stepType: 'tool_call',
                role: 'assistant',
                content: input.toolName,
                toolName: input.toolName,
                toolCallId: input.toolCallId,
                argsJson: safeJsonStringify(input.args, this.sensitiveValues),
            },
        ]);
    }
    reportToolResult(input) {
        collectSensitiveValues(input.result, this.sensitiveValues);
        this.reportSteps([
            {
                stepType: 'tool_result',
                role: 'tool',
                content: input.toolName,
                toolName: input.toolName,
                toolCallId: input.toolCallId,
                resultJson: safeJsonStringify(input.result, this.sensitiveValues),
                isError: input.isError,
                ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
            },
        ]);
    }
    reportAssistantMessage(input) {
        collectSensitiveValues(input.model, this.sensitiveValues);
        if (input.model)
            this.targetModel = describeModel(input.model) ?? this.targetModel;
        this.reportSteps([
            {
                stepType: 'message',
                role: 'assistant',
                content: maskText(input.content, this.sensitiveValues),
                rawJson: safeJsonStringify({
                    stop_reason: input.stopReason,
                    error_message: input.errorMessage,
                    target_model: this.targetModel,
                }, this.sensitiveValues),
            },
        ]);
    }
    reportUsage(input) {
        collectSensitiveValues(input.model, this.sensitiveValues);
        if (input.model)
            this.targetModel = describeModel(input.model) ?? this.targetModel;
        this.reportSteps([
            {
                stepType: 'usage',
                role: 'system',
                content: 'model_usage',
                usageJson: safeJsonStringify(input.usage, this.sensitiveValues),
            },
        ]);
    }
    reportRuntimeEvent(input, independent = Boolean(input.origin)) {
        if (!this.turnId && !independent)
            return false;
        this.reportRuntimeEvents([input], input.delivery !== 'batched', independent);
        if (input.delivery === 'batched' && this.pendingSteps.length > 0 && !this.batchTimer) {
            this.batchTimer = setTimeout(() => this.flushPending(), 1_000);
            this.batchTimer.unref?.();
        }
        return true;
    }
    reportBufferedRuntimeEvents(inputs) {
        if (!this.turnId || inputs.length === 0)
            return;
        this.reportRuntimeEvents(inputs, false);
    }
    finishTurn(input) {
        try {
            this.reportSteps([
                {
                    stepType: 'session_lifecycle',
                    role: 'system',
                    content: `turn_${input.status}`,
                    ...(input.error
                        ? {
                            rawJson: safeJsonStringify({ error: input.error }, this.sensitiveValues),
                        }
                        : {}),
                },
            ], true);
        }
        finally {
            this.turnId = '';
        }
    }
    reportMetaInfo(metaInfo, sessionMetadata) {
        const step = buildLocalEvalMetaInfoStep(metaInfo, this.sensitiveValues);
        const sizeBytes = Buffer.byteLength(step.usageJson, 'utf8');
        recordMetaInfoPayload(this.metricsClient, sizeBytes, this.maxStepFieldBytes);
        if (sizeBytes > this.maxStepFieldBytes)
            return;
        this.reportSteps([step], false, true, sessionMetadata);
    }
    reportRuntimeEvents(inputs, flushImmediately, independent = inputs.every((input) => Boolean(input.origin))) {
        this.reportSteps(inputs.map((input) => ({
            stepType: 'runtime_event',
            role: 'system',
            content: input.eventType,
            ...(input.isError === undefined ? {} : { isError: input.isError }),
            usageJson: safeJsonStringify(input.payload, this.sensitiveValues),
            ...(input.origin?.toolCallId ? { toolCallId: input.origin.toolCallId } : {}),
        })), flushImmediately, independent);
    }
    reportSteps(inputs, flushImmediately = false, independent = false, sessionMetadata = this.sessionMetadata) {
        if ((!this.turnId && !independent) || inputs.length === 0)
            return;
        const steps = inputs.map((input) => {
            const timestamp = this.nowMs();
            return {
                ...input,
                content: truncateUtf8(input.content, this.maxStepFieldBytes),
                ...(input.argsJson === undefined
                    ? {}
                    : { argsJson: truncateUtf8(input.argsJson, this.maxStepFieldBytes) }),
                ...(input.resultJson === undefined
                    ? {}
                    : { resultJson: truncateUtf8(input.resultJson, this.maxStepFieldBytes) }),
                ...(input.usageJson === undefined
                    ? {}
                    : { usageJson: truncateUtf8(input.usageJson, this.maxStepFieldBytes) }),
                ...(input.rawJson === undefined
                    ? {}
                    : { rawJson: truncateUtf8(input.rawJson, this.maxStepFieldBytes) }),
                stepIndex: this.factory.nextStepIndex(timestamp),
                clientProducedTs: timestamp,
            };
        });
        if (this.pendingSteps.length > 0 && this.pendingSessionMetadata !== sessionMetadata) {
            this.flushPending();
        }
        this.pendingSessionMetadata = sessionMetadata;
        this.pendingSteps.push(...steps);
        if (flushImmediately || this.pendingSteps.length >= MAX_BATCH_STEPS) {
            this.flushPending();
        }
    }
    flushPending() {
        if (this.batchTimer)
            clearTimeout(this.batchTimer);
        this.batchTimer = undefined;
        this.factory.releaseRuntimeReporter(this.context.sessionId, this);
        if (this.pendingSteps.length === 0)
            return;
        const steps = this.pendingSteps;
        const sessionMetadata = this.pendingSessionMetadata;
        this.pendingSteps = [];
        this.pendingSessionMetadata = this.sessionMetadata;
        const batches = buildReportEvalStepBodies(this.trajectoryId, steps, MAX_BATCH_STEPS, MAX_REPORT_BODY_BYTES, sessionMetadata);
        if (batches.droppedStepIndexes.length > 0) {
            logger.warn({
                sessionId: this.context.sessionId,
                stepIndexes: batches.droppedStepIndexes,
                maxBodyBytes: MAX_REPORT_BODY_BYTES,
            }, '[eval-capture] skipped eval steps that exceed the upload body budget');
        }
        for (const batch of batches.bodies) {
            this.factory.enqueue({ kind: 'steps', ...batch }, this.context.sessionId);
        }
    }
}
//# sourceMappingURL=reporter.js.map