var __esDecorate = (this && this.__esDecorate) || function (ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
    function accept(f) { if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected"); return f; }
    var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
    var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
    var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
    var _, done = false;
    for (var i = decorators.length - 1; i >= 0; i--) {
        var context = {};
        for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
        for (var p in contextIn.access) context.access[p] = contextIn.access[p];
        context.addInitializer = function (f) { if (done) throw new TypeError("Cannot add initializers after decoration has completed"); extraInitializers.push(accept(f || null)); };
        var result = (0, decorators[i])(kind === "accessor" ? { get: descriptor.get, set: descriptor.set } : descriptor[key], context);
        if (kind === "accessor") {
            if (result === void 0) continue;
            if (result === null || typeof result !== "object") throw new TypeError("Object expected");
            if (_ = accept(result.get)) descriptor.get = _;
            if (_ = accept(result.set)) descriptor.set = _;
            if (_ = accept(result.init)) initializers.unshift(_);
        }
        else if (_ = accept(result)) {
            if (kind === "field") initializers.unshift(_);
            else descriptor[key] = _;
        }
    }
    if (target) Object.defineProperty(target, contextIn.name, descriptor);
    done = true;
};
var __runInitializers = (this && this.__runInitializers) || function (thisArg, initializers, value) {
    var useValue = arguments.length > 2;
    for (var i = 0; i < initializers.length; i++) {
        value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
    }
    return useValue ? value : void 0;
};
import { bindTool } from '@mavis/agent-core/tools';
import { LocalAskUserToolDef } from './builtin-defs.js';
// Model-facing results for AskUser v2 questionnaires. Kept short: the tool
// description already explains sync/async; these only state what happened
// and what the model should do next. The async result repeats the assumption
// rule from the tool description's `async: true` line in the same words, so the
// model gets one rule rather than two: only an answer that decides the
// deliverable's direction must not be assumed, and proceeding on a likely
// answer for anything else must be stated as an assumption.
//
// In Goal mode with the `skip` policy a question waits at most 60 seconds; if
// nobody answers, the runtime selects each question's recommended option and
// the result opens with `goalAutoSelected`. Why not answer at once: in the
// 2026-10-22 local Desktop check, a Goal question that returned immediately
// with "proceed on the recommended option" led the model to report the
// recommended option as the user's choice and complete the Goal on it. Legacy
// Goal questionnaires adopted the recommendation only after a timeout, marked
// as not confirmed by the user; this follows them, and the text says outright
// that these are not the user's choices.
export const ASK_USER_RESULT_TEXT = {
    syncOverridden: "Note: the user's settings require questions in this context to wait for an answer, so this call waited even though async was requested.",
    syncDismissed: 'The user did not answer this question (skipped or closed it). Do not ask it again; continue as if it is unanswered. The user may still answer later; the answer would arrive as a new message.',
    syncNewMessage: 'The user did not answer this question and sent a new message instead. Handle the new message. The question stays open and may still be answered later.',
    syncNewMessageQueued: 'The user did not answer this question and sent a new message instead, which will be handled after this turn. End this turn now instead of continuing. The question stays open and may still be answered later.',
    asyncShown: "The question is shown to the user; this call did not wait for an answer. Keep doing work that does not depend on the answer. Never assume an answer that decides the deliverable's direction; if your next step depends on one, end this turn instead. Where you proceed on a likely answer for anything else, state it as an assumption. If the user answers, the answer arrives as a new message; do not ask again.",
    asyncOverridden: "The user's settings make questions in this context never wait, so this call did not wait even though it asked to.",
    goalAutoSelected: "The user did not answer within 60 seconds, so the recommended option for each question was selected automatically. These are not the user's choices: when you mention them, say they were selected automatically and the user can still change them; never say the user chose or replied. Proceed on them. Never take an irreversible, externally visible, authentication, or other safety-sensitive action on an automatically selected answer; leave that step undone and continue other work. If the user wants something else, they will tell you in a new message.",
};
let LocalAskUserTool = (() => {
    let _classDecorators = [bindTool(LocalAskUserToolDef)];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    var LocalAskUserTool = class {
        static { _classThis = this; }
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
            __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
            LocalAskUserTool = _classThis = _classDescriptor.value;
            if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
            __runInitializers(_classThis, _classExtraInitializers);
        }
        adapter;
        constructor(adapter) {
            this.adapter = adapter;
        }
        async execute(ctx, input, signal) {
            if (signal?.aborted)
                throw new Error('Operation aborted');
            // A sync v2 questionnaire waits inside this call. Stop rejects the wait
            // with the "stopped while waiting" message, which pi-agent-core records as
            // this call's error result; nothing else is injected.
            const result = await this.adapter.begin(ctx, input, signal);
            if ('suppressed' in result) {
                // Decision v3: a question raised while the user already has an
                // instruction in flight is superseded, not asked. No questionnaire
                // exists, nothing renders, and the turn keeps running (no terminate).
                const text = 'Question not asked: the user already sent a new instruction while this question was being raised. Follow the incoming user message instead.';
                return {
                    tool_name: LocalAskUserToolDef.name,
                    text,
                    content: [{ type: 'text', text }],
                    details: {
                        suppressed: true,
                        reason: result.reason,
                        waiting_for_user: false,
                    },
                };
            }
            if ('responseMode' in result)
                return v2Result(result);
            // Legacy questionnaire (CLI/TUI runtime, IM Turn, feature-enable): unchanged
            // turn-ending protocol; the answer arrives later as a user message.
            const text = `Questionnaire ${result.requestId} is waiting for the local user. Stop this turn until the user replies.`;
            return {
                tool_name: LocalAskUserToolDef.name,
                text,
                content: [{ type: 'text', text }],
                details: {
                    request_id: result.requestId,
                    schema_version: result.schemaVersion,
                    step_count: result.stepCount,
                    waiting_for_user: true,
                },
                terminate: true,
            };
        }
    };
    return LocalAskUserTool = _classThis;
})();
export { LocalAskUserTool };
/**
 * v2 questionnaires never terminate the Turn, so `waiting_for_user` is always
 * false: the Goal orchestrator must not treat the Turn as parked on the user.
 */
function v2Result(result) {
    const text = v2Text(result);
    const answered = result.outcome?.kind === 'answered' ? result.outcome : undefined;
    return {
        tool_name: LocalAskUserToolDef.name,
        text,
        content: [{ type: 'text', text }, ...(answered?.imageContent ?? [])],
        details: {
            request_id: result.requestId,
            schema_version: result.schemaVersion,
            step_count: result.stepCount,
            waiting_for_user: false,
            response_mode: result.responseMode,
            policy_overridden: result.policyOverridden,
            answered: result.outcome?.kind === 'answered',
            ...(answered?.autoSelected ? { auto_selected: true } : {}),
            ...(answered?.contextImages?.length ? { context_images: answered.contextImages } : {}),
            ...((result.outcome?.kind === 'answered' || result.outcome?.kind === 'dismissed') &&
                result.outcome.answers
                ? { answers: result.outcome.answers }
                : {}),
        },
    };
}
function v2Text(result) {
    if (result.responseMode === 'async') {
        const shown = `Question ${result.requestId}: ${ASK_USER_RESULT_TEXT.asyncShown}`;
        return result.policyOverridden ? `${ASK_USER_RESULT_TEXT.asyncOverridden} ${shown}` : shown;
    }
    switch (result.outcome?.kind) {
        case 'answered':
            // Flagged by the runtime, never inferred from the answer text.
            if (result.outcome.autoSelected) {
                return `${ASK_USER_RESULT_TEXT.goalAutoSelected}\n\n${result.outcome.content}`;
            }
            return result.policyOverridden
                ? `${result.outcome.content}\n\n${ASK_USER_RESULT_TEXT.syncOverridden}`
                : result.outcome.content;
        case 'new_message':
            return ASK_USER_RESULT_TEXT.syncNewMessage;
        // A queued message only reaches the model after this Turn ends, so the
        // model must stop instead of continuing on stale intent.
        case 'new_message_queued':
            return ASK_USER_RESULT_TEXT.syncNewMessageQueued;
        case 'dismissed':
            return result.outcome.content
                ? `${result.outcome.content}\n\n${ASK_USER_RESULT_TEXT.syncDismissed}`
                : ASK_USER_RESULT_TEXT.syncDismissed;
        default:
            return ASK_USER_RESULT_TEXT.syncDismissed;
    }
}
//# sourceMappingURL=local-ask-user.js.map