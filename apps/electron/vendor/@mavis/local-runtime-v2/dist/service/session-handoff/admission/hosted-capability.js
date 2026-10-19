import { randomUUID } from 'node:crypto';
import { HandoffPreparationError, preparationFailure } from './preparation-error.js';
import { handoffStage, observeHandoff, } from './observability.js';
const CLOUD_HANDOFF_INTENT = 'cloud-handoff';
const CLOUD_HANDOFF_TAG = /<\/?cloud-session-handoff\b[^>]*>/giu;
export class HostedCloudHandoffCapability {
    makeDispatchId;
    turns = new Map();
    port;
    constructor(makeDispatchId = randomUUID) {
        this.makeDispatchId = makeDispatchId;
    }
    bind(port) {
        if (this.port)
            throw new Error('hosted_cloud_handoff_already_bound');
        this.port = port;
    }
    submissionPreparation = {
        prepare: async (input) => {
            if (input.clientIntent !== CLOUD_HANDOFF_INTENT)
                return undefined;
            const port = this.port;
            const dispatchId = this.makeDispatchId();
            let prepared;
            const key = turnKey(input);
            return {
                status: 'ready',
                commit: async () => undefined,
                beforeHost: async (signal) => {
                    signal.throwIfAborted();
                    const started = Date.now();
                    const identity = {
                        attemptType: 'preparation',
                        attemptId: input.turnId,
                        sessionId: input.sessionId,
                        dispatchId,
                        stage: 'preparation',
                    };
                    const observe = (event) => {
                        observeHandoff(port?.diagnostics ?? {}, event);
                    };
                    observe({ ...identity, event: 'attempt_started', outcome: 'started' });
                    try {
                        if (!port)
                            throw new HandoffPreparationError('HANDOFF_PREFLIGHT_UNAVAILABLE');
                        const result = await port.prepare({
                            localSessionId: input.sessionId,
                            dispatchId,
                            turnId: input.turnId,
                            signal,
                            ...(input.genuineUserQueryText ? { userQuery: input.genuineUserQueryText } : {}),
                        });
                        if ('deferred' in result) {
                            throw new HandoffPreparationError('HANDOFF_SESSION_STATE_INVALID');
                        }
                        if ('denied' in result) {
                            throw new HandoffPreparationError(`HANDOFF_PREFLIGHT_DENIED:${result.denied}`);
                        }
                        prepared = result;
                        signal.throwIfAborted();
                        await prepared.commit();
                        signal.throwIfAborted();
                        this.turns.set(key, { dispatchId: prepared.dispatchId, markerEmitted: false });
                        observe({
                            ...identity,
                            event: 'attempt_finished',
                            outcome: 'success',
                            durationMs: Date.now() - started,
                        });
                    }
                    catch (error) {
                        const failure = preparationFailure(error);
                        const failedOutcome = failure.publicFailure.code.startsWith('HANDOFF_PREFLIGHT_DENIED')
                            ? 'denied'
                            : 'failed';
                        observe({
                            ...identity,
                            event: 'attempt_finished',
                            outcome: signal.aborted ? 'aborted' : failedOutcome,
                            code: failure.publicFailure.code,
                            durationMs: Date.now() - started,
                        });
                        if (signal.aborted)
                            throw signal.reason;
                        throw failure;
                    }
                },
                rollback: async () => undefined,
                compensate: async () => {
                    this.turns.delete(key);
                    if (prepared)
                        await handoffStage(port?.diagnostics ?? {}, {
                            attemptType: 'preparation',
                            attemptId: input.turnId,
                            sessionId: input.sessionId,
                            dispatchId,
                        }, 'proposal_compensation', () => prepared.compensate());
                },
            };
        },
    };
    extension = {
        id: 'local-cloud-handoff',
        description: 'Prepare a Desktop Session for explicit Cloud handoff approval.',
        init: (pi) => {
            pi.contributeUserPromptPrefix((turn) => this.buildUserPromptPrefix(turn));
            pi.on('before_tool_call', (_input, _signal, turn) => this.beforeToolCall(turn));
            pi.on('after_llm_call', (input, turn) => this.afterLlmCall(input, turn));
            pi.on('turn_end', async (_event, turn) => {
                const key = turnKey(turn);
                const active = this.turns.get(key);
                this.turns.delete(key);
                if (!active || !this.port)
                    return;
                if (active.markerEmitted) {
                    await this.port.completeAnnouncement({
                        localSessionId: turn.sessionId,
                        dispatchId: active.dispatchId,
                    });
                }
                else {
                    await this.port.failAnnouncement({
                        dispatchId: active.dispatchId,
                        reason: 'Cloud handoff announcement did not complete',
                    });
                }
            });
        },
    };
    async buildUserPromptPrefix(turn) {
        if (turn.turnIntent?.kind !== CLOUD_HANDOFF_INTENT)
            return undefined;
        const key = turnKey(turn);
        let active = this.turns.get(key);
        if (!active) {
            const recovered = await this.port?.getCurrentProposal(turn.sessionId);
            if (!recovered)
                return undefined;
            active = { dispatchId: recovered.dispatchId, markerEmitted: false };
            this.turns.set(key, active);
        }
        return [
            'The Desktop runtime has prepared a Cloud handoff proposal for this Session.',
            "Reply briefly in the user's language that the proposal is ready for file review and explicit upload approval.",
            'Do not call tools. Do not list or infer candidate paths, hashes, sizes, or sensitivity.',
            'Do not emit a <cloud-session-handoff> tag; the runtime appends the canonical marker.',
        ].join(' ');
    }
    beforeToolCall(identity) {
        if (!this.turns.has(turnKey(identity)))
            return undefined;
        return {
            block: true,
            reason: 'CLOUD_HANDOFF_NO_TOOLS: This Turn only announces a prepared Cloud handoff proposal.',
        };
    }
    afterLlmCall(input, identity) {
        const active = this.turns.get(turnKey(identity));
        if (!active)
            return undefined;
        const text = input.message.content
            .filter((block) => block.type === 'text')
            .map((block) => block.text)
            .join('');
        const stripped = text.replace(CLOUD_HANDOFF_TAG, '').trimEnd();
        if (input.message.content.some((block) => block.type === 'toolCall') ||
            input.message.stopReason === 'error' ||
            input.message.stopReason === 'aborted') {
            return stripped === text
                ? { type: 'continue' }
                : { type: 'replaceText', text: stripped };
        }
        this.turns.set(turnKey(identity), { ...active, markerEmitted: true });
        const marker = `<cloud-session-handoff dispatch-id="${active.dispatchId}" />`;
        return {
            type: 'replaceText',
            text: stripped.length > 0 ? `${stripped}\n\n${marker}` : marker,
        };
    }
}
function turnKey(input) {
    return `${input.sessionId}\u0000${input.turnId}`;
}
//# sourceMappingURL=hosted-capability.js.map