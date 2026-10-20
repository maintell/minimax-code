import { LocalBackgroundTaskService } from './service.js';
import { FsLocalTaskOutputStore, SqliteLocalBackgroundTaskStore } from './store.js';
export { LocalBackgroundTaskService } from './service.js';
export { FsLocalTaskOutputStore, SqliteLocalBackgroundTaskStore } from './store.js';
export { abortAllBackgroundLocalBashTasks } from './bash-runner.js';
export { createUserStopCascade } from './user-stop-cascade.js';
export { backgroundTaskNotificationReceiptId } from './conversation-delivery.js';
export { isTaskDeliverySuppressed } from './user-stop-suppression.js';
export function createLocalBackgroundTaskService(dataDir, nowMs, stopRuntime, onTerminal) {
    return new LocalBackgroundTaskService({
        store: new SqliteLocalBackgroundTaskStore(dataDir, nowMs),
        outputStore: new FsLocalTaskOutputStore(dataDir),
        nowMs,
        ...(stopRuntime ? { stopRuntime } : {}),
        ...(onTerminal ? { onTerminal } : {}),
    });
}
//# sourceMappingURL=index.js.map