import { ExtensionServiceError } from '../errors.js';
/** The composer's suggestion slot takes one line of at most this many characters. */
const MAX_SUGGESTION_LENGTH = 120;
/** `ctx.prompt.suggest` argument → its text; production and `/testing` share this check. */
export function validateSuggestionText(args) {
    const text = args?.text;
    if (typeof text !== 'string' ||
        !text.trim() ||
        text.length > MAX_SUGGESTION_LENGTH ||
        /[\r\n]/u.test(text)) {
        throw new ExtensionServiceError('ARGUMENT_INVALID', `prompt.suggest takes { text }: non-blank, one line, at most ${MAX_SUGGESTION_LENGTH} characters`);
    }
    return text;
}
//# sourceMappingURL=prompt-suggestion.js.map