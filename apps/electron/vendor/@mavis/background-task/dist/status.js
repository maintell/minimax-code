export const ACTIVE_TASK_STATUSES = [
    'queued',
    'running',
    'stopping',
];
export const TERMINAL_TASK_STATUSES = [
    'succeeded',
    'failed',
    'canceled',
    'lost',
];
export function isActiveTaskStatus(status) {
    return ACTIVE_TASK_STATUSES.includes(status);
}
export function isTerminalTaskStatus(status) {
    return TERMINAL_TASK_STATUSES.includes(status);
}
export function canTransitionTaskStatus(from, to) {
    if (from === to)
        return true;
    if (isTerminalTaskStatus(from))
        return false;
    switch (from) {
        case 'queued':
            return ['running', 'stopping', 'succeeded', 'failed', 'canceled', 'lost'].includes(to);
        case 'running':
            return ['stopping', 'succeeded', 'failed', 'canceled', 'lost'].includes(to);
        case 'stopping':
            return ['succeeded', 'failed', 'canceled', 'lost'].includes(to);
        default:
            return false;
    }
}
//# sourceMappingURL=status.js.map