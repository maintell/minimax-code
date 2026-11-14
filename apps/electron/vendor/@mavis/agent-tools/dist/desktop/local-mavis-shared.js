import { z } from 'zod';
export const optionalString = z.string().optional();
export const optionalNumber = z.number().int().nonnegative().optional();
export const optionalBoolean = z.boolean().optional();
export const idString = z.string().min(1, 'ID must be a non-empty string');
export function success(command, response) {
    return { ok: true, command, response };
}
export function failure(command, kind, message, extra = {}) {
    return { ok: false, command, error: { kind, message, ...extra } };
}
export class LocalMavisValidationError extends Error {
    details;
    constructor(message, details = {}) {
        super(message);
        this.details = details;
        this.name = 'LocalMavisValidationError';
    }
}
export class LocalMavisRuntimeError extends Error {
    status;
    code;
    constructor(message, details = {}) {
        super(message);
        this.name = 'LocalMavisRuntimeError';
        this.status = details.status;
        this.code = details.code;
    }
}
export function requireSessionAdapter(ctx) {
    if (!ctx.sessionAdapter) {
        throw new LocalMavisRuntimeError('Local session service is not configured', {
            code: 'SESSION_UNAVAILABLE',
            status: 503,
        });
    }
    return ctx.sessionAdapter;
}
//# sourceMappingURL=local-mavis-shared.js.map