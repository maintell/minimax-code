/** Bunny's working-state ledger ("近期约定"), spec 13. */
export const WORKING_STATE_TOOL_NAME = 'working_state';
export const WORKING_STATE_KINDS = [
    'correction',
    'constraint',
    'open_question',
    'context_gap',
];
export const WORKING_STATE_STATUSES = ['active', 'superseded', 'done'];
const WORKING_STATE_CLOSE_REASONS = ['done', 'answered', 'withdrawn', 'expired'];
/** Closed entries stay in the injected ledger, marked closed, for this long (13.3). */
export const CLOSED_ENTRY_INJECTION_MS = 7 * 24 * 60 * 60 * 1000;
/** The global-constraint excerpt appended to a task's execution reminder (13.8). */
export const GLOBAL_CONSTRAINT_EXCERPT_TOKENS = 500;
/**
 * The ledger of a state block without a delivery baseline is cut like the handoff header's,
 * to this many tokens (dogfood fixes spec 8.4).
 */
export const FULL_BLOCK_LEDGER_TOKENS = 2_500;
export class WorkingStateError extends Error {
    status;
    code;
    constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
        this.name = 'WorkingStateError';
    }
}
//# sourceMappingURL=contracts.js.map