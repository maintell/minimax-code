import { HTTPException } from 'hono/http-exception';
import { QuestionnairePurpose as DesktopQuestionnairePurpose, QuestionnaireSelectionMode, QuestionnaireStatus, } from '@mavis/thrift-gen/generated/desktop-service/types';
import { parseExplicitStableName } from '../agent/contract.js';
import { DesktopChannelServiceBase } from './desktop-channel-service.js';
import { jsonError } from './desktop-service-support.js';
import { LocalQuestionnaireError, LocalQuestionnaireService, } from '../questionnaire/service.js';
export class DesktopQuestionnaireServiceBase extends DesktopChannelServiceBase {
    questionnaireService;
    constructor(memory, questionnaire, agentResolver, telemetryHost) {
        super(memory, agentResolver, telemetryHost);
        this.questionnaireService = questionnaire
            ? new DesktopQuestionnaireService(questionnaire, agentResolver)
            : undefined;
    }
    beginQuestionnaire(ctx, req) {
        return this.requireQuestionnaire().beginQuestionnaire(ctx, req);
    }
    replyQuestionnaire(ctx, req) {
        return this.requireQuestionnaire().replyQuestionnaire(ctx, req);
    }
    dismissQuestionnaire(ctx, req) {
        return this.requireQuestionnaire().dismissQuestionnaire(ctx, req);
    }
    getPendingQuestionnaire(ctx, req) {
        return this.requireQuestionnaire().getPendingQuestionnaire(ctx, req);
    }
    getQuestionnaire(ctx, req) {
        return this.requireQuestionnaire().getQuestionnaire(ctx, req);
    }
    getLatestPlanReview(ctx, req) {
        return this.requireQuestionnaire().getLatestPlanReview(ctx, req);
    }
    requireQuestionnaire() {
        if (this.questionnaireService)
            return this.questionnaireService;
        throw new HTTPException(500, {
            res: jsonError(500, 'Questionnaire service is not available', 'QUESTIONNAIRE_NOT_AVAILABLE'),
        });
    }
}
class DesktopQuestionnaireService {
    deps;
    agentResolver;
    constructor(deps, agentResolver) {
        this.deps = deps;
        this.agentResolver = agentResolver;
    }
    async beginQuestionnaire(ctx, req) {
        void ctx;
        return this.mapErrors(async () => {
            const result = await this.service().begin({
                toolInput: toSharedToolInput(req.toolInput),
                sessionId: req.sessionId,
                agentName: req.agentName,
                messageId: req.messageId,
                callId: req.callId,
                runId: req.runId,
            });
            return {
                requestId: result.requestId,
                schemaVersion: result.schemaVersion,
                stepCount: result.stepCount,
            };
        }, 'QUESTIONNAIRE_BEGIN_ERROR');
    }
    async replyQuestionnaire(ctx, req) {
        void ctx;
        return this.mapErrors(async () => this.service().reply({
            agentName: await this.resolveExactAgentName(req.name),
            requestId: req.requestId,
            reply: toSharedReplyPayload(req),
        }), 'QUESTIONNAIRE_REPLY_ERROR');
    }
    async dismissQuestionnaire(ctx, req) {
        void ctx;
        return this.mapErrors(async () => this.service().dismiss({
            agentName: await this.resolveExactAgentName(req.name),
            requestId: req.requestId,
        }), 'QUESTIONNAIRE_DISMISS_ERROR');
    }
    async getPendingQuestionnaire(ctx, req) {
        void ctx;
        return this.mapErrors(async () => {
            const record = await this.service().getPending({
                agentName: await this.resolveExactAgentName(req.name),
                sessionId: req.sessionId,
            });
            return { ...(record ? { request: toDesktopRequestView(record.request) } : {}) };
        }, 'QUESTIONNAIRE_GET_ERROR');
    }
    async getQuestionnaire(ctx, req) {
        void ctx;
        return this.mapErrors(async () => {
            const record = await this.service().get({
                agentName: await this.resolveExactAgentName(req.name),
                requestId: req.requestId,
            });
            return toDesktopQuestionnaireResponse(record);
        }, 'QUESTIONNAIRE_GET_ERROR');
    }
    async getLatestPlanReview(ctx, req) {
        void ctx;
        return this.mapErrors(async () => {
            const record = await this.service().getLatestPlanReview({
                agentName: await this.resolveExactAgentName(req.name),
                sessionId: req.sessionId,
            });
            return toDesktopQuestionnaireResponse(record);
        }, 'QUESTIONNAIRE_GET_ERROR');
    }
    service() {
        return new LocalQuestionnaireService(this.deps.serviceDeps());
    }
    async resolveExactAgentName(requestedName) {
        const requested = requestedName.trim();
        if (!requested.toLowerCase().startsWith('agent:'))
            return requested;
        if (this.agentResolver)
            return this.agentResolver.requireExactAgentKey(requested);
        return parseExplicitStableName(requested);
    }
    async mapErrors(fn, fallbackCode) {
        try {
            return await fn();
        }
        catch (err) {
            if (err instanceof LocalQuestionnaireError) {
                throw new HTTPException(err.status, {
                    res: jsonError(err.status, err.message, err.code),
                });
            }
            const message = err instanceof Error ? err.message : String(err);
            throw new HTTPException(500, { res: jsonError(500, message, fallbackCode) });
        }
    }
}
function toDesktopQuestionnaireResponse(record) {
    if (!record)
        return {};
    return {
        request: toDesktopRequestView(record.request),
        status: toDesktopStatus(record.status),
        sessionId: record.sessionId,
        agentName: record.agentName,
        createdAt: record.createdAt,
        answeredAt: record.answeredAt,
        dismissedAt: record.dismissedAt,
    };
}
function toSharedToolInput(input) {
    return {
        ...(input.title ? { title: input.title } : {}),
        ...(input.mode ? { mode: input.mode } : {}),
        ...(input.modePayload
            ? {
                modePayload: {
                    ...(input.modePayload.featureKey !== undefined
                        ? { featureKey: input.modePayload.featureKey }
                        : {}),
                },
            }
            : {}),
        ...(input.steps
            ? {
                steps: input.steps.map((step) => ({
                    ...(step.id ? { id: step.id } : {}),
                    ...(step.header ? { header: step.header } : {}),
                    question: step.question,
                    ...(step.description ? { description: step.description } : {}),
                    ...(step.image ? { image: step.image } : {}),
                    ...(step.options ? { options: step.options } : {}),
                    ...(step.selectionMode !== undefined
                        ? {
                            selectionMode: step.selectionMode === QuestionnaireSelectionMode.Multiple
                                ? 'multiple'
                                : 'single',
                        }
                        : {}),
                })),
            }
            : {}),
    };
}
function toSharedReplyPayload(req) {
    return {
        schemaVersion: req.schemaVersion,
        requestId: req.requestId,
        answers: req.answers.map(toSharedReplyAnswer),
        submittedAt: typeof req.submittedAt === 'number' ? req.submittedAt : Date.now(),
    };
}
function toSharedReplyAnswer(answer) {
    return {
        stepId: answer.stepId,
        selectedOptionIds: answer.selectedOptionIds ?? [],
        selectedOther: answer.selectedOther === true,
        ...(answer.otherText ? { otherText: answer.otherText } : {}),
        ...(answer.skipped === true ? { skipped: true } : {}),
    };
}
function toDesktopRequestView(request) {
    return {
        schemaVersion: request.schemaVersion,
        id: request.id,
        title: request.title,
        tool: request.tool
            ? { messageId: request.tool.message_id, callId: request.tool.call_id }
            : undefined,
        requester: request.requester,
        presentation: request.presentation,
        steps: request.steps.map((step) => ({
            ...step,
            selectionMode: toDesktopSelectionMode(step.selectionMode),
            options: step.options,
        })),
        expiresAt: request.expiresAt,
        purpose: request.purpose === 'goal' ? DesktopQuestionnairePurpose.Goal : undefined,
        status: request.status ? toDesktopStatus(request.status) : undefined,
        createdAt: request.createdAt,
        mode: request.mode ?? 'questionnaire',
        ...(request.modePayload
            ? {
                modePayload: {
                    ...(request.modePayload.featureKey
                        ? { featureKey: request.modePayload.featureKey }
                        : {}),
                    ...(request.modePayload.planReview
                        ? {
                            planReview: {
                                markdown: request.modePayload.planReview.markdown,
                                path: request.modePayload.planReview.path,
                            },
                        }
                        : {}),
                },
            }
            : {}),
    };
}
function toDesktopSelectionMode(value) {
    return value === 'multiple'
        ? QuestionnaireSelectionMode.Multiple
        : QuestionnaireSelectionMode.Single;
}
function toDesktopStatus(value) {
    switch (value) {
        case 'answered':
            return QuestionnaireStatus.Answered;
        case 'expired':
            return QuestionnaireStatus.Expired;
        case 'superseded':
            return QuestionnaireStatus.Superseded;
        case 'dismissed':
            return QuestionnaireStatus.Dismissed;
        case 'pending':
        default:
            return QuestionnaireStatus.Pending;
    }
}
//# sourceMappingURL=desktop-questionnaire-service.js.map