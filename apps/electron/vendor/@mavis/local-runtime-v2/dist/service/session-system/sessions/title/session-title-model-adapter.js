import { randomUUID } from 'node:crypto';
import { Type, validateToolArguments } from '@earendil-works/pi-ai';
import { completeTitleModelResponse, } from './title-model-completion.js';
import { normalizeSessionTitleCandidate, } from './session-title-service.js';
const SUBMIT_SESSION_TITLE = 'submit_session_title';
const SESSION_TITLE_TOOL = {
    name: SUBMIT_SESSION_TITLE,
    description: 'Submit the concise title for this Session.',
    parameters: Type.Object({ title: Type.String() }, { additionalProperties: false }),
};
const SESSION_TITLE_REVIEW_TOOL = {
    name: 'review_session_title',
    description: 'Keep the title, or replace it for a clear improvement or when the conversation has no name yet.',
    parameters: Type.Object({
        action: Type.Union([Type.Literal('keep'), Type.Literal('replace')]),
        title: Type.Optional(Type.String()),
    }, { additionalProperties: false }),
};
/** Transport-neutral model adapter for normal first-turn title generation. */
export class SessionTitleModelAdapter {
    options;
    makeTurnId;
    constructor(options) {
        this.options = options;
        this.makeTurnId = options.makeTurnId ?? (() => `turn_title_${randomUUID()}`);
    }
    async review(input) {
        const response = await completeTitleModelResponse({
            ...this.options,
            nowMs: this.options.nowMs ?? Date.now,
            buildAgentConfig: (session) => this.options.buildAgentConfig(session, 'review'),
            resolveModel: (scope) => this.options.resolveModel({ ...scope, purpose: 'review' }),
        }, { ...input, turnId: this.makeTurnId(), tools: [SESSION_TITLE_REVIEW_TOOL] });
        const call = singleToolCall(response, SESSION_TITLE_REVIEW_TOOL.name);
        if (!call)
            return null;
        return parseReviewDecision(call);
    }
    async summarize(input) {
        const response = await completeTitleModelResponse({
            buildAgentConfig: this.options.buildAgentConfig,
            resolveModel: this.options.resolveModel,
            stream: this.options.stream,
            nowMs: this.options.nowMs ?? Date.now,
        }, {
            ...input,
            turnId: this.makeTurnId(),
            tools: [SESSION_TITLE_TOOL],
        });
        const call = singleToolCall(response, SUBMIT_SESSION_TITLE);
        if (!call)
            return null;
        try {
            const validated = validateToolArguments(SESSION_TITLE_TOOL, call);
            return normalizeSessionTitleCandidate(validated.title);
        }
        catch {
            return null;
        }
    }
}
function singleToolCall(response, name) {
    if (response.content.some((part) => part.type === 'text' && part.text?.trim()))
        return null;
    const calls = response.content.filter((part) => part.type === 'toolCall');
    const call = calls[0];
    return calls.length === 1 && call && isToolCall(call) && call.name === name ? call : null;
}
function isToolCall(input) {
    return (input.type === 'toolCall' &&
        typeof input.id === 'string' &&
        typeof input.name === 'string' &&
        input.arguments !== undefined);
}
function parseReviewDecision(call) {
    try {
        const decision = validateToolArguments(SESSION_TITLE_REVIEW_TOOL, call);
        if (decision.action !== 'replace')
            return { action: decision.action };
        if (typeof decision.title !== 'string')
            return null;
        const title = normalizeSessionTitleCandidate(decision.title);
        return title ? { action: 'replace', title } : null;
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=session-title-model-adapter.js.map