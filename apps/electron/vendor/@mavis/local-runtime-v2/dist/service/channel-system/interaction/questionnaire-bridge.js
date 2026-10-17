/**
 * Bridge instance. Stateless apart from the injected hooks — safe to share
 * across all platform adapters and all clientNames.
 */
export class LocalChannelQuestionnaireBridge {
    onSubmit;
    nowMs;
    constructor(options = {}) {
        this.onSubmit = options.onSubmit ?? (async () => undefined);
        this.nowMs = options.nowMs ?? (() => Date.now());
    }
    /**
     * Render a questionnaire by handing it to the adapter's unified outbound
     * channel. The bridge does NOT translate the payload — it stays in
     * {@link ChannelQuestionnaire} (= {@link AskQuestionnaireRequest}) form so
     * the adapter's wire-encoder consumes the same value object the rest of
     * the runtime (UI composer, questionnaire store) already speaks.
     *
     * The optional `text` is sent alongside the questionnaire so platforms
     * that ignore the structured field (numbered-text fallback) still receive
     * the human-readable form. Defaults to the questionnaire title, or to an
     * empty string when no title is set.
     */
    async present(input) {
        const text = input.text ?? input.questionnaire.title ?? input.questionnaire.steps[0]?.question ?? '';
        if (input.adapter.renderQuestionnaire) {
            const result = await input.adapter.renderQuestionnaire({
                ctx: input.ctx,
                renderable: toRenderableQuestionnaire(input.questionnaire),
            });
            return { id: result.outboundMessageId ?? '', status: 'sent' };
        }
        return input.adapter.sendMessage({
            ctx: input.ctx,
            text,
            questionnaire: input.questionnaire,
            ...(input.sessionId ? { sessionId: input.sessionId } : {}),
            ...(input.queueItemId ? { queueItemId: input.queueItemId } : {}),
        });
    }
    /**
     * Accept a decoded reply from an adapter and hand it to the host's
     * continuation. Adapters call this after they have parsed their native
     * action payload (Feishu card action, Telegram numbered text reply, …)
     * into the canonical {@link AskQuestionnaireReplyPayload} shape — the
     * bridge never inspects the wire format itself.
     *
     * `submittedAt` is filled in from {@link LocalChannelQuestionnaireBridgeOptions.nowMs}
     * if the adapter did not provide one, so the reply payload is always
     * well-formed even when the platform callback omits a timestamp.
     */
    async submit(input) {
        const reply = input.reply.submittedAt
            ? input.reply
            : { ...input.reply, submittedAt: this.nowMs() };
        await this.onSubmit({ ctx: input.ctx, reply });
    }
    /**
     * Build a canonical {@link AskQuestionnaireReplyPayload} from a flat list
     * of per-step selections. Adapters that receive a structured option-id
     * payload (Feishu card action, Telegram callback_query) call this helper
     * so the schema-version + tail invariants stay centralised.
     *
     * Each `answer` MAY carry its own `selectedOther` / `otherText` /
     * `skipped` flags; defaults match the V2 schema (no Others, not skipped).
     * Unknown extra keys are dropped — only the well-known fields survive.
     */
    buildReply(input) {
        return {
            schemaVersion: 2,
            requestId: input.requestId,
            answers: input.answers.map((raw) => ({
                stepId: raw.stepId,
                selectedOptionIds: Array.isArray(raw.selectedOptionIds) ? [...raw.selectedOptionIds] : [],
                selectedOther: raw.selectedOther === true,
                ...(typeof raw.otherText === 'string' ? { otherText: raw.otherText } : {}),
                ...(raw.skipped === true ? { skipped: true } : {}),
            })),
            submittedAt: input.submittedAt ?? this.nowMs(),
        };
    }
}
export function toRenderableQuestionnaire(questionnaire) {
    return {
        requestId: questionnaire.id,
        ...(questionnaire.title ? { title: questionnaire.title } : {}),
        steps: questionnaire.steps.map((step) => ({
            stepId: step.id,
            question: step.question,
            ...(step.description ? { description: step.description } : {}),
            selectionMode: step.selectionMode,
            allowOther: true,
            options: step.options.map((option) => ({
                optionId: option.id,
                label: option.label,
                ...(option.description ? { description: option.description } : {}),
            })),
        })),
    };
}
/**
 * Decoder for a single Feishu card-action payload that an adapter has already
 * extracted from the wire shape. Centralised here so the same decode logic
 * stays test-covered independently of the SDK transport.
 *
 * Feishu interactive card action callback shape (simplified):
 *
 *   {
 *     token: '...',
 *     action: { value: '<json>' | { ... }, tag: 'button' | 'select' | 'overflow' },
 *     ...
 *   }
 *
 * The adapter passes `action.value` (already JSON-parsed if it was a string)
 * and the questionnaire instance the bridge should match against. Returns
 * `undefined` when the value does not look like a questionnaire-option token
 * — the adapter then treats the click as an unrelated card and ignores it,
 * which is the safer default than throwing.
 */
export function decodeQuestionnaireOptionToken(value) {
    const parsed = parseTokenLike(value);
    if (!parsed)
        return undefined;
    if (parsed.v !== 1)
        return undefined;
    if (typeof parsed.r !== 'string' || !parsed.r)
        return undefined;
    if (typeof parsed.s !== 'string' || !parsed.s)
        return undefined;
    if (parsed.o !== null && typeof parsed.o !== 'string')
        return undefined;
    return { v: 1, r: parsed.r, s: parsed.s, o: parsed.o };
}
function parseTokenLike(value) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        return value;
    }
    if (typeof value !== 'string' || !value.trim())
        return undefined;
    try {
        const parsed = JSON.parse(value);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed;
        }
    }
    catch {
        return undefined;
    }
    return undefined;
}
//# sourceMappingURL=questionnaire-bridge.js.map