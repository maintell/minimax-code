/**
 * The one failure type every desktop Agent tool service throws. `code` is a
 * stable value from `DESKTOP_TOOL_ERROR_CODES`, which is what the tool reports
 * and what the metric label counts.
 *
 * It lives with the sidebar tools rather than with `desktop-agent-tools`
 * because that service already composes this one: dependency-cruiser only
 * allows the edge in that direction, so a module both of them import has to sit
 * on this side.
 */
export class DesktopAgentToolError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = 'DesktopAgentToolError';
    }
}
/** Keeps a thrown Application error's own status when it carries one. */
export function mapToolError(error, fallback) {
    if (error instanceof DesktopAgentToolError)
        return error;
    return new DesktopAgentToolError(toolErrorCode(error), error instanceof Error ? error.message : fallback);
}
/**
 * A project id the model gave, as the number the Application use cases take.
 * Both desktop tool services take the id as a string on the wire.
 */
export function toProjectId(value) {
    const projectId = Number(value);
    if (!Number.isInteger(projectId) || projectId <= 0) {
        throw new DesktopAgentToolError('INVALID_ARGUMENT', `Not a project id: ${value}`);
    }
    return projectId;
}
const STATUS_ERROR_CODES = new Map([
    [400, 'INVALID_ARGUMENT'],
    [404, 'NOT_FOUND'],
    [409, 'CONFLICT'],
]);
function toolErrorCode(error) {
    const reason = error?.reason;
    if (typeof reason === 'string' && reason.includes('not-found'))
        return 'NOT_FOUND';
    const status = error?.status;
    if (typeof status === 'number')
        return STATUS_ERROR_CODES.get(status) ?? 'INTERNAL';
    return 'INTERNAL';
}
//# sourceMappingURL=errors.js.map