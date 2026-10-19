import { CloudSessionReadError } from '@mavis/agent-tools/desktop';
import { AppError } from '../errors.js';
export function isCloudSessionRead(source) {
    if (source === undefined || source === 'local')
        return false;
    if (source === 'cloud')
        return true;
    throw new AppError(400, 'INVALID_SESSION_SOURCE', 'Session read source must be local or cloud');
}
export async function readCloudSession(read) {
    if (!read)
        throw new AppError(503, 'CLOUD_READ_UNAVAILABLE', 'Cloud session reading is unavailable on this host');
    try {
        return await read();
    }
    catch (error) {
        if (error instanceof CloudSessionReadError)
            throw new AppError(error.status, error.key, error.message);
        throw error;
    }
}
//# sourceMappingURL=session-read-source.js.map