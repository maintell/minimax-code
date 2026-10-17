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
/** Transport-neutral model adapter for normal first-turn title generation. */
export class SessionTitleModelAdapter {
    options;
    makeTurnId;
    constructor(options) {
        this.options = options;
        this.makeTurnId = options.makeTurnId ?? (() => `turn_title_${randomUUID()}`);
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
        if (response.content.some((part) => part.type === 'text' && part.text?.trim()))
            return null;
        const toolParts = response.content.filter((part) => part.type === 'toolCall');
        const call = toolParts[0];
        if (toolParts.length !== 1 ||
            !call ||
            !isToolCall(call) ||
            call.name !== SUBMIT_SESSION_TITLE) {
            return null;
        }
        try {
            const validated = validateToolArguments(SESSION_TITLE_TOOL, call);
            return normalizeSessionTitleCandidate(validated.title);
        }
        catch {
            return null;
        }
    }
}
function isToolCall(input) {
    return (input.type === 'toolCall' &&
        typeof input.id === 'string' &&
        typeof input.name === 'string' &&
        input.arguments !== undefined);
}
//# sourceMappingURL=session-title-model-adapter.js.map