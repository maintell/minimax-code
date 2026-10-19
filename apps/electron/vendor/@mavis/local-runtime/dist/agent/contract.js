const MAX_AGENT_NAME_LENGTH = 64;
const WINDOWS_RESERVED_AGENT_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu;
export class LocalAgentContractError extends Error {
    status;
    code;
    details;
    constructor(status, message, code, details) {
        super(message);
        this.status = status;
        this.code = code;
        this.details = details;
        this.name = 'LocalAgentContractError';
    }
}
export function validateAgentName(name) {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
        throw new LocalAgentContractError(400, 'Agent name is required', 'VALIDATION_ERROR');
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
        throw new LocalAgentContractError(400, 'Agent name contains invalid characters', 'VALIDATION_ERROR');
    }
    return trimmed;
}
export function parseExplicitStableName(value) {
    if (!value.toLowerCase().startsWith('agent:'))
        return validateAgentName(value);
    const stable = value.slice('agent:'.length);
    if (!stable) {
        throw new LocalAgentContractError(400, 'Agent name is required', 'VALIDATION_ERROR');
    }
    return validateAgentName(stable);
}
//# sourceMappingURL=contract.js.map