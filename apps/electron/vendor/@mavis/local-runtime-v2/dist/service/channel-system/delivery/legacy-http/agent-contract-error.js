export function isAgentContractLikeError(err) {
    return (err instanceof Error &&
        err.name === 'LocalAgentContractError' &&
        typeof err.status === 'number' &&
        typeof err.code === 'string');
}
/**
 * Channel-system-local twin of the v1 class for facades that must THROW the
 * agent-resolver-unavailable contract themselves (e.g. Lark onboarding when
 * no write resolver is wired). Carries the same name so the one structural
 * predicate above recognizes both origins.
 */
export class AgentContractHttpError extends Error {
    status;
    code;
    constructor(status, message, code) {
        super(message);
        this.status = status;
        this.code = code;
        this.name = 'LocalAgentContractError';
    }
}
const MAX_AGENT_NAME_LENGTH = 64;
const WINDOWS_RESERVED_AGENT_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu;
/**
 * Migration copy of the v1 agent-name validation (same rules, channel-local
 * error class). The bind routes gate raw request agent names through this
 * before touching any store. Permanent since MR3: the channel system owns
 * its own copy so the wire contract stays stable without a v1 import.
 */
export function validateAgentName(name) {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
        throw new AgentContractHttpError(400, 'Agent name is required', 'VALIDATION_ERROR');
    }
    if (trimmed !== name ||
        trimmed.length > MAX_AGENT_NAME_LENGTH ||
        trimmed.includes('/') ||
        trimmed.includes('\\') ||
        trimmed === '.' ||
        trimmed === '..' ||
        trimmed.endsWith('.') ||
        WINDOWS_RESERVED_AGENT_NAMES.test(trimmed) ||
        /[\u0000-\u001f\u007f]/u.test(trimmed)) {
        throw new AgentContractHttpError(400, 'Agent name contains invalid characters', 'VALIDATION_ERROR');
    }
    return trimmed;
}
//# sourceMappingURL=agent-contract-error.js.map