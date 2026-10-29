/**
 * Pi turn runner boundary types.
 *
 * These are explicit per-turn contracts owned by `pi-turn-runner`. They
 * describe the model, event writer, user message, and tool configuration
 * supplied to `PiTurnRunner.runTurn(...)`; hosts may own event identity when
 * Pi attempts and native tools must share one logical-Turn sequence.
 */
export function normalizeAbortSource(value) {
    switch (value) {
        case 'user_stop':
        case 'session_leave':
        case 'agent_interrupt':
        case 'immediate_send':
        case 'input_safety':
        case 'output_safety':
        case 'lifecycle':
            return value;
        default:
            return 'unknown';
    }
}
//# sourceMappingURL=types.js.map