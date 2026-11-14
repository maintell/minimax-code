/**
 * Module loads are the one message family that only writes records, so they
 * are dispatched before the state machine switch instead of adding cases to
 * it. A failed `import()` may report twice (see the guest loader), which is
 * why both members share one handler.
 */
export function isScriptMessage(message) {
    return message.type === 'script_loaded' || message.type === 'script_rejected';
}
//# sourceMappingURL=records.js.map