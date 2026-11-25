import { BUNNY_TOOL_NOT_AVAILABLE, coordinatorRefusalText, } from './local-mavis-coordinator-text.js';
import { coordinatorMavisBackedRefusal } from './local-mavis-namespaced-tools.js';
/**
 * The one answer a trusted coordinator gets for a namespaced tool outside its
 * allowlist, whichever route the call arrived on: the executor guard in front
 * of the tool, and the refusal a PTC program reaches for the same name. A
 * mavis-backed tool answers with its command's own refusal — the assignment
 * tool that replaced a session command, or the reason the Agent roster and MCP
 * settings are the user's — and every other tool with the shared one. Both
 * routes read these words because both call this function.
 */
export function coordinatorHiddenToolRefusal(name) {
    const mavisBacked = coordinatorMavisBackedRefusal(name);
    if (mavisBacked !== undefined)
        return mavisBacked;
    const text = coordinatorRefusalText(name, 'BUNNY_COMMAND_NOT_AVAILABLE', BUNNY_TOOL_NOT_AVAILABLE);
    return {
        tool_name: name,
        text,
        content: [{ type: 'text', text }],
        isError: true,
        // The metric label and the failure log read the bounded code from here.
        details: { ok: false, errorCode: 'INVALID_ARGUMENT' },
    };
}
//# sourceMappingURL=local-coordinator-tool-refusal.js.map