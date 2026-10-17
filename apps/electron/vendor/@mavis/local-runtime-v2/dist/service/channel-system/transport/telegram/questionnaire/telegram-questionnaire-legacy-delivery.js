import { toRenderableQuestionnaire } from '../../../interaction/questionnaire-bridge.js';
import { buildTelegramQuestionnaireKeyboard, formatTelegramQuestionnairePrompt, } from './telegram-questionnaire.js';
/**
 * Fallback for legacy clients constructed without a `TelegramPlatformAdapter`.
 * It renders the questionnaire keyboard but cannot register pending state, so
 * production wiring must prefer adapter delegation for clickable replies.
 */
export async function sendTelegramQuestionnaireFallback(input) {
    const renderable = toRenderableQuestionnaire(input.request);
    await input.sender.sendText(input.chatId, formatTelegramQuestionnairePrompt(renderable), buildTelegramQuestionnaireKeyboard(renderable));
}
//# sourceMappingURL=telegram-questionnaire-legacy-delivery.js.map