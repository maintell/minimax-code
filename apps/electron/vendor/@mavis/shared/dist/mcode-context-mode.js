export const MCODE_CONTEXT_MODES = ['standard', 'lightweight'];
/**
 * Immutable marker for an explicitly created lightweight root Session.
 *
 * Purpose is already persisted with Sessions and intentionally does not flow
 * into child Sessions, which have their own task/side-session purpose.
 */
export const LIGHTWEIGHT_SESSION_PURPOSE = 'context-mode:lightweight';
//# sourceMappingURL=mcode-context-mode.js.map