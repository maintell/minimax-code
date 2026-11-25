import { AppError } from '../errors.js';
export function messageApplicationError(error) {
    switch (error.reason) {
        case 'session-not-found':
            return new AppError(404, 'SESSION_NOT_FOUND', error.message);
        case 'data-corrupt':
            return new AppError(500, 'MESSAGE_DATA_CORRUPT', error.message);
    }
}
export function fileSyncApplicationError(error) {
    if (error.reason === 'session-not-found') {
        return new AppError(404, 'SESSION_NOT_FOUND', error.message);
    }
    if (error.reason === 'file-not-found') {
        return new AppError(404, 'SESSION_FILE_NOT_FOUND', error.message);
    }
    return new AppError(400, 'INVALID_SESSION_FILE_SYNC', error.message);
}
export function inputSummaryApplicationError(error) {
    return new AppError(error.reason === 'session-not-found' ? 404 : 400, error.reason === 'session-not-found'
        ? 'SESSION_NOT_FOUND'
        : 'INVALID_SESSION_INPUT_SUMMARY_PAGINATION', error.message);
}
export function sourceHistoryApplicationError(error) {
    return new AppError(error.reason === 'session-not-found' ? 404 : 400, error.reason === 'session-not-found'
        ? 'SESSION_NOT_FOUND'
        : 'INVALID_SESSION_SOURCE_PAGINATION', error.message);
}
//# sourceMappingURL=content-errors.js.map