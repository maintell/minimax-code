import { toRenderableQuestionnaire, } from '../../../interaction/questionnaire-bridge.js';
import { buildTelegramStepKeyboard, decodeTelegramQuestionnaireCallback, formatTelegramStepPrompt, } from './telegram-questionnaire.js';
import { imLogger as logger } from '@mavis/shared/local-runtime-logging/im-logger';
export class TelegramQuestionnaireRuntime {
    resolveSender;
    /**
     * Pending questionnaires keyed by chatId. Telegram inline buttons can only
     * carry one step/option per click, so this pending is a per-chat accumulator:
     * each callback records one step answer and advances the original message to
     * the next step; only the final step returns a complete reply to the runner.
     */
    pendingByChat = new Map();
    constructor(resolveSender) {
        this.resolveSender = resolveSender;
    }
    async sendInitial(input) {
        const renderable = toRenderableQuestionnaire(input.request);
        const sent = await input.sender.sendText(input.ctx.chatId, formatTelegramStepPrompt(renderable, 0), buildTelegramStepKeyboard(renderable, 0), input.ctx.threadId);
        this.pendingByChat.set(input.ctx.chatId, {
            requestId: input.request.id,
            rid6: telegramRidShort(input.request.id),
            chatId: input.ctx.chatId,
            ...(sent?.messageId !== undefined ? { messageId: sent.messageId } : {}),
            request: input.request,
            renderable,
            currentStepIndex: 0,
            answers: new Map(),
            createdAt: Date.now(),
        });
    }
    async tryHandleReply(input) {
        const callback = readQuestionnaireCallback(input.raw);
        if (!callback)
            return null;
        const { decoded, callbackQueryId } = callback;
        const sender = await this.resolveSender(input.ctx);
        const pending = this.pendingByChat.get(input.ctx.chatId);
        const rejection = classifyCallbackRejection(pending, decoded);
        if (rejection || !pending) {
            await answerQuestionnaireCallback(sender, callbackQueryId, rejection ?? '这个问卷已提交或过期');
            return { handled: true };
        }
        const active = pending;
        // classifyCallbackRejection proved these lookups succeed.
        const step = active.request.steps[decoded.stepIndex];
        const option = step.options[decoded.optionIndex];
        active.answers.set(step.id, {
            stepId: step.id,
            selectedOptionIds: [option.id],
            selectedOther: false,
        });
        return this.advanceOrFinish({
            ctx: input.ctx,
            active,
            decoded,
            sender,
            callbackQueryId,
            option,
        });
    }
    /** Post-answer step advance, or the final reply payload when all answered. */
    async advanceOrFinish(step) {
        const { active, sender, callbackQueryId } = step;
        const nextStepIndex = nextUnansweredStepIndex(active, step.decoded.stepIndex + 1);
        if (nextStepIndex === null) {
            // Mark before the callback acknowledgement await so two concurrent
            // final callbacks cannot both produce a host reply.
            active.inFlight = true;
        }
        await answerQuestionnaireCallback(sender, callbackQueryId, `✓ 已选 ${step.option.label}`);
        if (nextStepIndex !== null) {
            active.currentStepIndex = nextStepIndex;
            await editQuestionnaireMessage(sender, active, formatTelegramStepPrompt(active.renderable, nextStepIndex), buildTelegramStepKeyboard(active.renderable, nextStepIndex));
            return { handled: true };
        }
        const reply = {
            schemaVersion: 2,
            requestId: active.requestId,
            submittedAt: Date.now(),
            answers: orderedAnswers(active),
        };
        return { ctx: step.ctx, reply };
    }
    async settleReply(input) {
        const pending = this.pendingByChat.get(input.ctx.chatId);
        if (!pending || pending.requestId !== input.requestId)
            return;
        if (input.outcome.status === 'retryable') {
            // Restore the retryable state before any Telegram API call. A failed
            // edit must not strand the request in-flight.
            pending.inFlight = false;
            try {
                const sender = await this.resolveSender(input.ctx);
                await editQuestionnaireMessage(sender, pending, formatTelegramStepPrompt(pending.renderable, pending.currentStepIndex), buildTelegramStepKeyboard(pending.renderable, pending.currentStepIndex));
            }
            catch (err) {
                logger.warn({ err, requestId: input.requestId }, 'Telegram questionnaire retry edit failed');
            }
            return;
        }
        // Accepted and terminal outcomes consume the in-memory pending before the
        // best-effort terminal card edit.
        this.pendingByChat.delete(input.ctx.chatId);
        try {
            const sender = await this.resolveSender(input.ctx);
            const submitted = input.outcome.status === 'accepted' ||
                (input.outcome.status === 'terminal' &&
                    input.outcome.code === 'QUESTIONNAIRE_ALREADY_ANSWERED');
            await editQuestionnaireMessage(sender, pending, submitted ? formatTelegramSubmittedText(pending) : '问卷已过期', { inline_keyboard: [] });
        }
        catch (err) {
            logger.warn({ err, requestId: input.requestId }, 'Telegram questionnaire settle edit failed');
        }
    }
}
async function answerQuestionnaireCallback(resolved, callbackQueryId, text) {
    if (!resolved || !callbackQueryId)
        return;
    try {
        await resolved.sender.answerCallbackQuery(callbackQueryId, { text });
    }
    catch (err) {
        logger.warn({ err }, 'Telegram answerCallbackQuery failed');
    }
}
async function editQuestionnaireMessage(resolved, pending, text, replyMarkup) {
    if (!resolved || pending.messageId === undefined)
        return;
    try {
        await resolved.sender.editMessageText(resolved.chatId, pending.messageId, text, replyMarkup);
    }
    catch (err) {
        logger.warn({ err, chatId: resolved.chatId, messageId: pending.messageId }, 'Telegram editMessageText failed');
    }
}
function telegramRidShort(requestId) {
    const hex = requestId.startsWith('ask_') ? requestId.slice(4) : requestId;
    return hex.slice(0, 6);
}
function nextUnansweredStepIndex(pending, startIndex) {
    for (let index = Math.max(0, startIndex); index < pending.request.steps.length; index += 1) {
        const step = pending.request.steps[index];
        if (!step)
            continue;
        if (!pending.answers.has(step.id))
            return index;
    }
    return null;
}
function orderedAnswers(pending) {
    const answers = [];
    for (const step of pending.request.steps) {
        const answer = pending.answers.get(step.id);
        if (answer)
            answers.push(answer);
    }
    return answers;
}
function formatTelegramSubmittedText(pending) {
    const lines = ['✅ 已提交'];
    if (pending.request.title) {
        lines.push('');
        lines.push(`问卷：${pending.request.title}`);
    }
    for (const [index, step] of pending.request.steps.entries()) {
        const answer = pending.answers.get(step.id);
        const labels = (answer?.selectedOptionIds ?? [])
            .map((id) => step.options.find((option) => option.id === id)?.label)
            .filter((label) => Boolean(label));
        lines.push('');
        lines.push(`${index + 1}. ${step.question}`);
        lines.push(`已选：${labels.join(', ') || '—'}`);
    }
    return lines.join('\n').trim();
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/**
 * The v1 guard ladder as one classifier: returns the user-visible rejection
 * toast, or null when the callback maps onto the current pending step+option.
 */
function classifyCallbackRejection(pending, decoded) {
    if (!pending)
        return '这个问卷已提交或过期';
    if (decoded.rid6 !== pending.rid6)
        return '这个问卷已过期';
    if (pending.inFlight)
        return '正在提交，请稍候';
    if (decoded.stepIndex !== pending.currentStepIndex)
        return '请按当前题目作答';
    const step = pending.request.steps[decoded.stepIndex];
    if (!step)
        return '这个选项不可用';
    if (decoded.optionIndex === null)
        return 'Telegram 暂不支持 Others，请选择上方选项';
    if (!step.options[decoded.optionIndex])
        return '这个选项不可用';
    return null;
}
/** Decode the questionnaire callback_query, or null for unrelated updates. */
function readQuestionnaireCallback(raw) {
    const record = isRecord(raw) ? raw : {};
    const update = isRecord(record.update) ? record.update : record;
    const callbackQuery = isRecord(update.callback_query) ? update.callback_query : undefined;
    if (!callbackQuery || typeof callbackQuery.data !== 'string')
        return null;
    const decoded = decodeTelegramQuestionnaireCallback(callbackQuery.data);
    if (!decoded)
        return null;
    return {
        decoded,
        callbackQueryId: typeof callbackQuery.id === 'string' ? callbackQuery.id : undefined,
    };
}
//# sourceMappingURL=telegram-questionnaire-runtime.js.map