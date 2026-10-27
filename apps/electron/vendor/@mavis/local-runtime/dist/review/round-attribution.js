import { logger as defaultLogger } from '../common/logger.js';
/**
 * Reports that the code review child round belongs to the Turn that asked for
 * the review (Goal token accounting). Returns the port to forget the pairing
 * with, or undefined when nothing was reported. Never throws.
 */
export async function attributeReviewRound(options, input) {
    const port = options.subSessionRoundAttribution?.();
    if (!port)
        return undefined;
    try {
        await port.attributeRound(input);
        return port;
    }
    catch (error) {
        (options.logger ?? defaultLogger).warn({
            sessionId: input.childSessionId,
            turnId: input.childTurnId,
            parentTurnId: input.parentTurnId,
            error: error instanceof Error ? error.message : String(error),
        }, 'Code review child round attribution failed');
        return undefined;
    }
}
//# sourceMappingURL=round-attribution.js.map