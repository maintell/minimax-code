import { randomBytes } from 'node:crypto';
import { ASK_OTHER_PLACEHOLDER, QUESTIONNAIRE_CONTEXT_IMAGE_LIMITS, } from '@mavis/shared/questionnaire';
export class QuestionnaireNormalizationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'QuestionnaireNormalizationError';
    }
}
export class QuestionnaireValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'QuestionnaireValidationError';
    }
}
const DEFAULT_PRESENTATION = Object.freeze({
    replaceComposer: true,
    showProgress: true,
    allowBackNavigation: true,
});
const FEATURE_ENABLE_PRESENTATION = Object.freeze({
    replaceComposer: false,
    showProgress: false,
    allowBackNavigation: false,
});
export function generateQuestionnaireRequestId() {
    return `ask_${randomBytes(12).toString('hex')}`;
}
function generateStepId(index) {
    return `q${index + 1}_${randomBytes(4).toString('hex')}`;
}
function generateOptionId(stepId, index) {
    return `${stepId}_opt${index + 1}`;
}
function isAllowedImageSrc(src) {
    const trimmed = src.trim();
    if (trimmed === '')
        return false;
    if (trimmed.startsWith('https://'))
        return true;
    if (trimmed.startsWith('/mavis/api/'))
        return true;
    if (trimmed.startsWith('/minimax-desktop/api/'))
        return true;
    return false;
}
export function normalizeAskUserInput(input, opts) {
    if (!input || typeof input !== 'object') {
        throw new QuestionnaireNormalizationError('ask_user input must be an object');
    }
    if (input.mode === 'feature-enable') {
        return normalizeFeatureEnableInput(input, opts);
    }
    validateQuestionnaireInput(input);
    const recommendations = opts.purpose === 'goal' || opts.recommendations === 'explicit-or-first'
        ? 'goal'
        : (opts.recommendations ?? 'none');
    const steps = normalizeSteps(input, recommendations);
    return buildQuestionnaireRequest(input, opts, steps);
}
function validateQuestionnaireInput(input) {
    if (input.mode !== undefined && input.mode !== 'questionnaire') {
        throw new QuestionnaireNormalizationError(`Unsupported ask_user mode: ${String(input.mode)}`);
    }
    if (input.modePayload !== undefined) {
        throw new QuestionnaireNormalizationError('ask_user questionnaire input must not include a mode payload');
    }
    if (!Array.isArray(input.steps)) {
        throw new QuestionnaireNormalizationError('ask_user input must include a non-empty `steps` array');
    }
}
function normalizeSteps(input, recommendations) {
    const steps = (input.steps ?? [])
        .map((step, idx) => normalizeStep(step, idx, recommendations))
        .filter((step) => step !== null);
    if (steps.length === 0) {
        throw new QuestionnaireNormalizationError('ask_user input must include at least one step with non-empty question text');
    }
    const seen = new Set();
    for (const step of steps) {
        // Keep model-supplied IDs when unique; rename duplicates so reply
        // validation can use a simple step-id map with no ambiguity.
        if (seen.has(step.id)) {
            step.id = generateStepId(seen.size);
        }
        seen.add(step.id);
    }
    return steps;
}
function buildQuestionnaireRequest(input, opts, steps) {
    const requestId = opts.requestId ?? generateQuestionnaireRequestId();
    const createdAt = opts.createdAt ?? Date.now();
    const request = {
        schemaVersion: 2,
        id: requestId,
        ...(input.mode === 'questionnaire' ? { mode: 'questionnaire' } : {}),
        presentation: { ...DEFAULT_PRESENTATION },
        steps,
        status: 'pending',
        createdAt,
        requester: questionnaireRequester(opts),
        ...(opts.purpose ? { purpose: opts.purpose } : {}),
        ...(opts.goalId ? { goalId: opts.goalId } : {}),
        ...(opts.expiresAt !== undefined ? { expiresAt: opts.expiresAt } : {}),
    };
    applyRequestMetadata(request, input, opts);
    return request;
}
function normalizeFeatureEnableInput(input, opts) {
    const featureKey = readNonEmptyString(input.modePayload?.featureKey);
    if (!featureKey) {
        throw new QuestionnaireNormalizationError('ask_user feature-enable input must include a non-empty `modePayload.featureKey`');
    }
    if (input.steps !== undefined) {
        throw new QuestionnaireNormalizationError('ask_user feature-enable input must not include questionnaire `steps`');
    }
    const requestId = opts.requestId ?? generateQuestionnaireRequestId();
    const createdAt = opts.createdAt ?? Date.now();
    const request = {
        schemaVersion: 2,
        id: requestId,
        mode: 'feature-enable',
        modePayload: { featureKey },
        presentation: { ...FEATURE_ENABLE_PRESENTATION },
        // Keep replies on the existing validator/service path. This synthetic
        // step is never rendered by the feature prompt.
        steps: [
            {
                id: 'feature-enable',
                question: `Enable ${featureKey}?`,
                selectionMode: 'single',
                options: [{ id: 'enable', label: 'Enable' }],
                allowOther: true,
                otherPlaceholder: ASK_OTHER_PLACEHOLDER,
                required: true,
            },
        ],
        status: 'pending',
        createdAt,
        requester: questionnaireRequester(opts),
    };
    applyRequestMetadata(request, input, opts);
    return request;
}
function questionnaireRequester(opts) {
    return {
        sessionId: opts.sessionId,
        ...(opts.agentName ? { agentName: opts.agentName } : {}),
        ...(opts.runId ? { runId: opts.runId } : {}),
        ...(opts.toolCallId ? { toolCallId: opts.toolCallId } : {}),
    };
}
function applyRequestMetadata(request, input, opts) {
    const title = readNonEmptyString(input.title);
    if (title)
        request.title = title;
    if (opts.toolMessageId && opts.toolCallId) {
        request.tool = { message_id: opts.toolMessageId, call_id: opts.toolCallId };
    }
}
export function validateQuestionnaireReply(request, payload) {
    validateReplyEnvelope(request, payload);
    const stepById = new Map(request.steps.map((step) => [step.id, step]));
    let imageCount = 0;
    const answeredStepIds = new Set();
    for (const answer of payload.answers) {
        if (!answer || typeof answer.stepId !== 'string') {
            throw new QuestionnaireValidationError('each answer must include a stepId string');
        }
        if (answeredStepIds.has(answer.stepId)) {
            throw new QuestionnaireValidationError(`duplicate answer for step ${answer.stepId}`);
        }
        answeredStepIds.add(answer.stepId);
        const step = stepById.get(answer.stepId);
        if (!step) {
            throw new QuestionnaireValidationError(`unknown stepId in reply: ${answer.stepId}`);
        }
        imageCount += validateAnswerContextImages(answer);
        if (imageCount > QUESTIONNAIRE_CONTEXT_IMAGE_LIMITS.count) {
            throw new QuestionnaireValidationError('Too many context images.');
        }
        validateStepAnswer(step, answer);
    }
    for (const step of request.steps) {
        if (step.required && !answeredStepIds.has(step.id)) {
            throw new QuestionnaireValidationError(`required step ${step.id} is missing from reply`);
        }
    }
}
function validateReplyEnvelope(request, payload) {
    if (payload.schemaVersion !== 2) {
        throw new QuestionnaireValidationError(`Unsupported schemaVersion: ${String(payload.schemaVersion)}. Expected 2.`);
    }
    if (payload.requestId !== request.id) {
        throw new QuestionnaireValidationError(`Reply requestId mismatch: payload=${payload.requestId} request=${request.id}`);
    }
    if (!Array.isArray(payload.answers)) {
        throw new QuestionnaireValidationError('answers must be an array');
    }
}
/** Context images ride only on an unskipped Others answer; returns how many this answer carries. */
function validateAnswerContextImages(answer) {
    if (answer.contextImages === undefined)
        return 0;
    const images = answer.contextImages;
    if (!Array.isArray(images) ||
        (images.length > 0 && (answer.skipped === true || answer.selectedOther !== true))) {
        throw new QuestionnaireValidationError('Context images require an unskipped Others answer.');
    }
    const ids = new Set();
    for (const image of images) {
        if (!isValidContextImageIdentity(image)) {
            throw new QuestionnaireValidationError('Invalid context image identity.');
        }
        const id = JSON.stringify([image.contextId, image.annotationId]);
        if (ids.has(id))
            throw new QuestionnaireValidationError('Duplicate context image.');
        ids.add(id);
    }
    return images.length;
}
function isValidContextImageIdentity(image) {
    return (Boolean(image) &&
        typeof image?.contextId === 'string' &&
        image.contextId.trim() !== '' &&
        image.contextId.length <= 2048 &&
        typeof image.annotationId === 'string' &&
        image.annotationId.trim() !== '' &&
        image.annotationId.length <= 128 &&
        Boolean(image.attachment));
}
function validateStepAnswer(step, answer) {
    const selectedIds = Array.isArray(answer.selectedOptionIds) ? answer.selectedOptionIds : [];
    const selectedOther = answer.selectedOther === true;
    const otherText = typeof answer.otherText === 'string' ? answer.otherText : '';
    if (answer.skipped === true) {
        if (selectedIds.length > 0 || selectedOther || otherText.trim() !== '') {
            throw new QuestionnaireValidationError(`step ${step.id}: skipped answer cannot carry selectedOptions / selectedOther / otherText`);
        }
        return;
    }
    validateSelectedOptions(step, selectedIds);
    if (selectedOther && otherText.trim() === '') {
        throw new QuestionnaireValidationError(`step ${step.id}: selectedOther is true but otherText is empty`);
    }
    validateRequiredSelection(step, selectedIds, selectedOther);
}
function validateRequiredSelection(step, selectedIds, selectedOther) {
    if (!selectedOther && selectedIds.length === 0 && step.required) {
        throw new QuestionnaireValidationError(`step ${step.id} is required but has no selected option, no Others text, and is not skipped`);
    }
    if (step.selectionMode === 'single' && selectedIds.length > 1) {
        throw new QuestionnaireValidationError(`step ${step.id} is single-choice but has ${selectedIds.length} selected options`);
    }
    if (step.selectionMode === 'single' && selectedOther && selectedIds.length > 0) {
        throw new QuestionnaireValidationError(`step ${step.id} is single-choice: Others cannot be selected alongside a normal option`);
    }
}
function validateSelectedOptions(step, selectedIds) {
    const validIds = new Set(step.options.map((option) => option.id));
    for (const optionId of selectedIds) {
        if (!validIds.has(optionId)) {
            throw new QuestionnaireValidationError(`unknown optionId ${optionId} for step ${step.id}`);
        }
    }
}
export function sanitizeReplyAnswers(payload) {
    return payload.answers.map((answer) => {
        if (answer.skipped === true) {
            return { stepId: answer.stepId, selectedOptionIds: [], selectedOther: false, skipped: true };
        }
        const sanitized = {
            stepId: answer.stepId,
            selectedOptionIds: Array.isArray(answer.selectedOptionIds)
                ? [...answer.selectedOptionIds]
                : [],
            selectedOther: answer.selectedOther === true,
        };
        if (sanitized.selectedOther && typeof answer.otherText === 'string') {
            sanitized.otherText = answer.otherText.trim();
        }
        if (sanitized.selectedOther && answer.contextImages?.length) {
            sanitized.contextImages = answer.contextImages.map(({ contextId, annotationId, attachment }) => ({
                contextId,
                annotationId,
                attachment: structuredClone(attachment),
            }));
        }
        return sanitized;
    });
}
function normalizeStep(raw, index, recommendations) {
    if (!raw || typeof raw.question !== 'string')
        return null;
    const question = raw.question.trim();
    if (!question)
        return null;
    const id = typeof raw.id === 'string' && raw.id.trim() !== '' ? raw.id.trim() : generateStepId(index);
    const step = {
        id,
        question,
        selectionMode: raw.selectionMode === 'multiple' ? 'multiple' : 'single',
        options: normalizeOptions(raw.options, id, recommendations),
        allowOther: true,
        otherPlaceholder: ASK_OTHER_PLACEHOLDER,
        required: true,
    };
    const header = readNonEmptyString(raw.header);
    const description = readNonEmptyString(raw.description);
    const image = normalizeImage(raw.image);
    if (header)
        step.header = header;
    if (description)
        step.description = description;
    if (image)
        step.image = image;
    return step;
}
function normalizeOptions(raw, stepId, recommendations) {
    if (!Array.isArray(raw))
        return [];
    const out = [];
    const seenIds = new Set();
    let hasRecommendation = false;
    raw.forEach((option, index) => {
        if (!option || typeof option.label !== 'string')
            return;
        const label = option.label.trim();
        if (!label)
            return;
        let id = typeof option.id === 'string' ? option.id.trim() : '';
        if (!id || seenIds.has(id))
            id = generateOptionId(stepId, index);
        seenIds.add(id);
        const normalized = { id, label };
        applyOptionDetails(normalized, option);
        if (recommendations !== 'none' && !hasRecommendation && option.recommended === true) {
            normalized.recommended = true;
            hasRecommendation = true;
        }
        out.push(normalized);
    });
    const first = out[0];
    // Fill one in only where an option can be adopted without the user: legacy
    // Goal questionnaires and v2 Goal questions (Goal + skip) both select it when
    // their deadline passes, so the highlighted option is the one selected.
    if (recommendations === 'goal' && first && !hasRecommendation)
        first.recommended = true;
    return out;
}
function applyOptionDetails(normalized, option) {
    const description = readNonEmptyString(option.description);
    const image = normalizeImage(option.image);
    if (description)
        normalized.description = description;
    if (image)
        normalized.image = image;
}
function normalizeImage(raw) {
    if (!raw || typeof raw.src !== 'string')
        return undefined;
    if (!isAllowedImageSrc(raw.src))
        return undefined;
    const image = { src: raw.src.trim() };
    const alt = readNonEmptyString(raw.alt);
    const caption = readNonEmptyString(raw.caption);
    if (alt)
        image.alt = alt;
    if (caption)
        image.caption = caption;
    return image;
}
function readNonEmptyString(value) {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}
//# sourceMappingURL=questionnaire-normalize.js.map