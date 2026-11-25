import { isPtcTurnEnabled as isSharedPtcTurnEnabled } from '@mavis/config';
export function isPtcTurnEnabled(requested) {
    // Same function and the same Session mode as the system prompt's ptc.enabled
    // (agent-profile.ts), so the prompt never promises run_code-only tools on a
    // Turn whose catalog kept them native, or the reverse.
    return isSharedPtcTurnEnabled({ requested });
}
//# sourceMappingURL=ptc-catalog-rules.js.map