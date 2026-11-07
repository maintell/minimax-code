import { logger } from '../logging/logger.js';
export function safeLog(level, fields, message) {
    try {
        const normalized = fields && typeof fields === 'object' ? fields : {};
        logger[level](normalized, message ?? '[pi-turn-runner]');
    }
    catch {
        // Logging is observability-only and must never alter a turn outcome.
    }
}
export const PI_TURN_RUNNER_LOGGER = {
    debug: (fields, message) => safeLog('info', fields, message),
    info: (fields, message) => safeLog('info', fields, message),
    warn: (fields, message) => safeLog('warn', fields, message),
    error: (fields, message) => safeLog('error', fields, message),
};
//# sourceMappingURL=pi-turn-logger.js.map