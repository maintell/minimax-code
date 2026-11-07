import {} from '../runtime-owner/app-mode.js';
/**
 * Bump when the per-session persisted data shape gains a new invariant.
 * Version 2 = sessions whose display-message writes maintain the session
 * asset index incrementally. Version 3 = branch sessions capture the effective
 * application mode used by the runtime; root sessions intentionally retain
 * their existing shape. Branch records without the field remain compatible
 * and resolve to the Coding default at the policy boundary.
 */
export const CURRENT_SESSION_DATA_VERSION = 3;
//# sourceMappingURL=session-record.js.map