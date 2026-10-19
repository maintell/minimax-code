import { randomUUID } from 'node:crypto';
export function createBackgroundTaskId() {
    return `bg_${randomUUID()}`;
}
export function createTaskLifecycleEventId() {
    return `bge_${randomUUID()}`;
}
//# sourceMappingURL=id.js.map