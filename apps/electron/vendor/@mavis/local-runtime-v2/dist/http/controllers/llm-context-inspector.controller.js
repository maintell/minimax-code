// Scaffolded by @mavis/thrift-gen — this file is yours after generation; edit freely.
import { LlmContextEpochReason, LlmContextPayloadState, LlmContextPrefixRelation, LlmContextSessionSource, } from '@mavis/thrift-gen/generated/desktop-service/types';
import { AppError } from '../../application/errors.js';
import { LlmContextInspectorServiceError, } from '../../service/llm-context-inspector/index.js';
import { NotImplementedError } from '../errors.js';
import { LlmContextInspectorControllerBase } from '../generated/llm-context-inspector-controller-base.gen.js';
export class LlmContextInspectorController extends LlmContextInspectorControllerBase {
    service;
    constructor(service) {
        super();
        this.service = service;
    }
    async getLlmContextCapture(ctx, req) {
        void ctx;
        void req;
        return runInspector(async () => ({ captureEnabled: this.require().getCaptureEnabled() }));
    }
    async putLlmContextCapture(ctx, req) {
        void ctx;
        return runInspector(async () => ({
            captureEnabled: await this.require().setCaptureEnabled(req.enabled === true),
        }));
    }
    async getLlmContextSessions(ctx, req) {
        void ctx;
        void req;
        return {
            sessions: (await runInspector(() => this.require().listSessions())).map((session) => ({
                ...session,
                source: toSessionSource(session.source),
            })),
        };
    }
    async getSessionLlmContextOverview(ctx, req) {
        void ctx;
        return toOverviewResponse(await runInspector(() => this.require().readOverview(req.sessionId, req.knownRevision)));
    }
    async getSessionLlmContextCall(ctx, req) {
        void ctx;
        return toCallResponse(await runInspector(() => this.require().readCall(req.sessionId, req.callId)));
    }
    async clearSessionLlmContextHistory(ctx, req) {
        void ctx;
        await runInspector(() => this.require().clearSessionHistory(req.sessionId));
        return {};
    }
    require() {
        if (!this.service)
            throw new NotImplementedError('llm context inspector service');
        return this.service;
    }
}
function toSessionSource(source) {
    return source === 'tui' ? LlmContextSessionSource.TUI : LlmContextSessionSource.ELECTRON;
}
async function runInspector(operation) {
    try {
        return await operation();
    }
    catch (error) {
        if (error instanceof LlmContextInspectorServiceError) {
            throw new AppError(error.status, error.code, error.message);
        }
        throw error;
    }
}
function toOverviewResponse(result) {
    if (result.unchanged || result.overview === undefined) {
        return { revision: result.revision, unchanged: true };
    }
    return {
        revision: result.revision,
        unchanged: false,
        overview: { turns: result.overview.turns.map(toTurnSummary) },
    };
}
function toTurnSummary(turn) {
    return {
        turnId: turn.turnId,
        turnOrdinal: turn.turnOrdinal,
        calls: turn.calls.map(toCallSummary),
    };
}
function toCallSummary(call) {
    return {
        callId: call.callId,
        callOrdinal: call.callOrdinal,
        startedAtMs: call.startedAtMs,
        durationMs: call.durationMs,
        providerId: call.providerId,
        modelId: call.modelId,
        apiId: call.apiId,
        attemptCount: call.attemptCount,
        ...(call.usage
            ? {
                usage: {
                    inputTokens: call.usage.input,
                    cacheReadTokens: call.usage.cacheRead,
                    cacheWriteTokens: call.usage.cacheWrite,
                    outputTokens: call.usage.output,
                },
            }
            : {}),
        prefixComparison: {
            relation: prefixRelationWireValue(call.prefixComparison.relation),
            ...(call.prefixComparison.baselineCallId
                ? { baselineCallId: call.prefixComparison.baselineCallId }
                : {}),
            ...(call.prefixComparison.firstDifferencePointer
                ? { firstDifferencePointer: call.prefixComparison.firstDifferencePointer }
                : {}),
            ...(call.prefixComparison.epochReason
                ? { epochReason: epochReasonWireValue(call.prefixComparison.epochReason) }
                : {}),
        },
        hasCompactionBefore: call.hasCompactionBefore,
        tools: call.tools.map((tool) => ({
            toolCallId: tool.toolCallId,
            toolName: tool.toolName,
            ...(tool.startedAtMs === undefined ? {} : { startedAtMs: tool.startedAtMs }),
            ...(tool.durationMs === undefined ? {} : { durationMs: tool.durationMs }),
            ...(tool.isError === undefined ? {} : { isError: tool.isError }),
        })),
    };
}
function toCallResponse(detail) {
    return {
        callId: detail.callId,
        requestState: payloadStateWireValue(detail.requestState),
        ...(detail.requestJson === undefined ? {} : { requestJson: detail.requestJson }),
        ...(detail.requestByteLength === undefined
            ? {}
            : { requestByteLength: detail.requestByteLength }),
        responseState: payloadStateWireValue(detail.responseState),
        ...(detail.responseJson === undefined ? {} : { responseJson: detail.responseJson }),
        ...(detail.responseByteLength === undefined
            ? {}
            : { responseByteLength: detail.responseByteLength }),
    };
}
function prefixRelationWireValue(relation) {
    return LlmContextPrefixRelation[relation];
}
function epochReasonWireValue(reason) {
    return LlmContextEpochReason[reason];
}
function payloadStateWireValue(state) {
    return LlmContextPayloadState[state];
}
//# sourceMappingURL=llm-context-inspector.controller.js.map