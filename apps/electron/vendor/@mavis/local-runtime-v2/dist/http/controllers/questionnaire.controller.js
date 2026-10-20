import { QuestionnairePurpose as DesktopQuestionnairePurpose, QuestionnaireSelectionMode, QuestionnaireStatus, } from '@mavis/thrift-gen/generated/desktop-service/types';
import { AppError, NotImplementedError } from '../errors.js';
import { QuestionnaireControllerBase } from '../generated/questionnaire-controller-base.gen.js';
/** Generated DesktopService adapter over Runtime's process-local questionnaire application. */
export class QuestionnaireController extends QuestionnaireControllerBase {
    facade;
    constructor(facade) {
        super();
        this.facade = facade;
    }
    async beginQuestionnaire(_ctx, req) {
        const facade = this.requireFacade('beginQuestionnaire');
        const begin = facade.begin;
        if (!begin)
            throw new NotImplementedError('beginQuestionnaire');
        return this.mapErrors(async () => {
            const result = await begin({
                toolInput: toSharedToolInput(req.toolInput),
                sessionId: req.sessionId,
                ...(req.agentName ? { agentName: req.agentName } : {}),
                ...(req.messageId ? { messageId: req.messageId } : {}),
                ...(req.callId ? { callId: req.callId } : {}),
                ...(req.runId ? { runId: req.runId } : {}),
            });
            return {
                requestId: result.requestId,
                schemaVersion: result.schemaVersion,
                stepCount: result.stepCount,
            };
        });
    }
    async replyQuestionnaire(_ctx, req) {
        const facade = this.requireFacade('replyQuestionnaire');
        return this.mapErrors(async () => {
            if (req.schemaVersion !== 2) {
                throw new AppError(400, 'QUESTIONNAIRE_INVALID_REPLY', `Unsupported schemaVersion: ${String(req.schemaVersion)}. Expected 2.`);
            }
            const result = await facade.reply({
                agentName: req.name,
                requestId: req.requestId,
                answers: req.answers.map(toSharedReplyAnswer),
                submittedAt: req.submittedAt ?? Date.now(),
            });
            return {
                ok: result.ok,
                requestId: result.requestId,
                sessionId: result.sessionId,
                ...(result.agentName ? { agentName: result.agentName } : {}),
                answeredAt: result.answeredAt,
            };
        });
    }
    async dismissQuestionnaire(_ctx, req) {
        const facade = this.requireFacade('dismissQuestionnaire');
        return this.mapErrors(async () => {
            const result = await facade.dismiss({ agentName: req.name, requestId: req.requestId });
            return {
                ok: result.ok,
                requestId: result.requestId,
                sessionId: result.sessionId,
                ...(result.agentName ? { agentName: result.agentName } : {}),
                dismissedAt: result.dismissedAt,
            };
        });
    }
    async getPendingQuestionnaire(_ctx, req) {
        const facade = this.requireFacade('getPendingQuestionnaire');
        return this.mapErrors(async () => {
            const request = await facade.getPending({ agentName: req.name, sessionId: req.sessionId });
            return request ? { request: toDesktopRequestView(request) } : {};
        });
    }
    async getQuestionnaire(_ctx, req) {
        const facade = this.requireFacade('getQuestionnaire');
        const get = facade.get;
        if (!get)
            throw new NotImplementedError('getQuestionnaire');
        return this.mapErrors(async () => {
            const record = await get({ agentName: req.name, requestId: req.requestId });
            return record ? toDesktopQuestionnaireResponse(record) : {};
        });
    }
    async getLatestPlanReview(_ctx, req) {
        const facade = this.requireFacade('getLatestPlanReview');
        return this.mapErrors(async () => {
            const record = await facade.getLatestPlanReview({
                agentName: req.name,
                sessionId: req.sessionId,
            });
            return record ? toDesktopQuestionnaireResponse(record) : {};
        });
    }
    requireFacade(method) {
        if (this.facade)
            return this.facade;
        throw new NotImplementedError(method);
    }
    async mapErrors(operation) {
        try {
            return await operation();
        }
        catch (error) {
            throw mapQuestionnaireError(error);
        }
    }
}
/** Non-owner hosts keep the generated route fail-closed. */
export const questionnaireController = new QuestionnaireController();
export function createQuestionnaireController(facade) {
    return new QuestionnaireController(facade);
}
function mapQuestionnaireError(error) {
    if (error instanceof AppError)
        return error;
    if (!isRecord(error))
        return error;
    const status = error.status;
    const code = error.code;
    const message = error.message;
    if (typeof status === 'number' &&
        Number.isSafeInteger(status) &&
        status >= 400 &&
        status <= 599 &&
        typeof code === 'string' &&
        typeof message === 'string') {
        return new AppError(status, code, message);
    }
    return error;
}
function toSharedToolInput(input) {
    return {
        ...(input.title ? { title: input.title } : {}),
        ...(input.mode ? { mode: input.mode } : {}),
        ...(input.requiresExplicitResponse !== undefined
            ? { requiresExplicitResponse: input.requiresExplicitResponse }
            : {}),
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
function toSharedReplyAnswer(answer) {
    return {
        stepId: answer.stepId,
        selectedOptionIds: answer.selectedOptionIds ?? [],
        selectedOther: answer.selectedOther === true,
        ...(answer.otherText ? { otherText: answer.otherText } : {}),
        ...(answer.skipped === true ? { skipped: true } : {}),
    };
}
function toDesktopQuestionnaireResponse(record) {
    return {
        request: toDesktopRequestView(record.request),
        status: toDesktopStatus(record.status),
        sessionId: record.sessionId,
        ...(record.agentName ? { agentName: record.agentName } : {}),
        createdAt: record.createdAt,
        ...(record.answeredAt !== undefined ? { answeredAt: record.answeredAt } : {}),
        ...(record.dismissedAt !== undefined ? { dismissedAt: record.dismissedAt } : {}),
    };
}
function toDesktopRequestView(request) {
    const view = {
        schemaVersion: request.schemaVersion,
        id: request.id,
        presentation: { ...request.presentation },
        steps: request.steps.map(toDesktopStep),
        mode: request.mode ?? 'questionnaire',
    };
    Object.assign(view, toDesktopRequestMetadata(request));
    return view;
}
function toDesktopRequestMetadata(request) {
    const metadata = {};
    if (request.title)
        metadata.title = request.title;
    if (request.tool) {
        metadata.tool = { messageId: request.tool.message_id, callId: request.tool.call_id };
    }
    if (request.requester)
        metadata.requester = { ...request.requester };
    if (request.expiresAt !== undefined)
        metadata.expiresAt = request.expiresAt;
    if (request.purpose === 'goal')
        metadata.purpose = DesktopQuestionnairePurpose.Goal;
    if (request.status)
        metadata.status = toDesktopStatus(request.status);
    if (request.createdAt !== undefined)
        metadata.createdAt = request.createdAt;
    if (request.modePayload)
        metadata.modePayload = toDesktopModePayload(request.modePayload);
    return metadata;
}
function toDesktopModePayload(payload) {
    const view = {};
    if (payload.featureKey)
        view.featureKey = payload.featureKey;
    if (payload.planReview)
        view.planReview = { ...payload.planReview };
    return view;
}
function toDesktopStep(step) {
    return {
        ...step,
        selectionMode: toDesktopSelectionMode(step.selectionMode),
        options: step.options.map((option) => ({
            ...option,
            ...(option.image ? { image: { ...option.image } } : {}),
        })),
        ...(step.image ? { image: { ...step.image } } : {}),
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
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=questionnaire.controller.js.map