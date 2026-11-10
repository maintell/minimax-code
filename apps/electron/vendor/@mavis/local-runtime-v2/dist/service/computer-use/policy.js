const COMPUTER_USE_PTC_STOPPED = 'COMPUTER_USE_PTC_STOPPED: an earlier Computer Use call in this run_code program failed, so later Computer Use calls of the program do not run. Return, read the failure, and decide the next step.';
/**
 * Stops the remaining Computer Use calls of a run_code program after one of
 * them fails. Computer Use acts on one shared desktop: a later click or key in
 * the same program usually depends on the state the failed call was meant to
 * reach, and a program cannot be trusted to check r.isError before going on.
 * Only children (calls with a parentToolCallId) are tracked; other tools of
 * the program, the next program and direct calls are not affected.
 */
export function createComputerUseTurnToolSafetyGuard() {
    const stoppedPrograms = new Set();
    return {
        beforeToolCall(input) {
            if (!input.parentToolCallId ||
                !stoppedPrograms.has(input.parentToolCallId) ||
                !isComputerUseToolName(input.toolCall.name)) {
                return undefined;
            }
            return { block: true, reason: COMPUTER_USE_PTC_STOPPED };
        },
        afterToolCall(input) {
            if (!input.parentToolCallId || !input.isError)
                return;
            if (isTrustedComputerUseToolCall(input.toolCall))
                stoppedPrograms.add(input.parentToolCallId);
        },
    };
}
/** Blocking a configured tool that merely imitates the name is harmless. */
function isComputerUseToolName(name) {
    return name.startsWith('computer_');
}
/**
 * The native tools carry no source marker. When one is present, a configured
 * or MCP tool that imitates the name cannot stop the program's real calls.
 */
function isTrustedComputerUseToolCall(toolCall) {
    if (!isComputerUseToolName(toolCall.name))
        return false;
    const source = toolCall.source;
    return source === undefined || source === 'builtin';
}
//# sourceMappingURL=policy.js.map