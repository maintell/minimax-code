/** Product identity sent as `User-Agent` on MiniMax Code third-party model requests. */
export const MINIMAX_CODE_USER_AGENT = 'MiniMaxCode';
/**
 * Adds the MiniMax Code `User-Agent` so providers can attribute traffic to the
 * product instead of the generic SDK default. A User-Agent the user configured
 * for the provider is kept, matched case-insensitively.
 */
export function withMiniMaxCodeUserAgent(headers) {
    const merged = { ...headers };
    if (Object.keys(merged).some((name) => name.toLowerCase() === 'user-agent'))
        return merged;
    merged['User-Agent'] = MINIMAX_CODE_USER_AGENT;
    return merged;
}
//# sourceMappingURL=minimax-code-user-agent.js.map