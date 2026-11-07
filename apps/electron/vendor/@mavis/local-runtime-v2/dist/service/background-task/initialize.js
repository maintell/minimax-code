import { LocalBackgroundTaskService } from './state/service.js';
import { BackgroundTaskRepository } from './storage/task.repository.js';
import { FsLocalTaskOutputStore } from './storage/output-store.js';
export function initializeBackgroundTaskService(input) {
    const outputStore = new FsLocalTaskOutputStore(input.dataDir);
    const service = new LocalBackgroundTaskService({
        store: new BackgroundTaskRepository(input.db, input.nowMs),
        outputStore,
        stopRuntime: input.stopRuntime,
        onTerminal: input.onTerminal,
        onChanged: input.onChanged,
        ...(input.onCreated ? { onCreated: input.onCreated } : {}),
        ...(input.nowMs ? { nowMs: input.nowMs } : {}),
    });
    return { service, outputStore };
}
//# sourceMappingURL=initialize.js.map