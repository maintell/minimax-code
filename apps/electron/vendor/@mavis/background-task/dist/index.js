/**
 * `@mavis/background-task` —— shared background task domain.
 *
 * This package is IO-free by design. It defines the cross-runtime task
 * vocabulary, lifecycle contracts, state helpers, and small in-memory
 * implementations for tests/adapters. Cloud and desktop runtimes provide
 * their own TaskStore, TaskOutputStore, and TaskRunner implementations.
 */
export { ACTIVE_TASK_STATUSES, TERMINAL_TASK_STATUSES, canTransitionTaskStatus, isActiveTaskStatus, isTerminalTaskStatus, } from './status.js';
export { BackgroundTaskError, InvalidTaskStatusTransitionError, TaskAlreadyExistsError, TaskNotFoundError, TaskRunnerAlreadyRegisteredError, TaskRunnerNotFoundError, normalizeTaskError, } from './errors.js';
export { createBackgroundTaskId, createTaskLifecycleEventId } from './id.js';
export { DefaultBackgroundTaskManager } from './manager.js';
export { InMemoryTaskStore } from './in-memory-store.js';
export { InMemoryTaskOutputStore } from './in-memory-output-store.js';
//# sourceMappingURL=index.js.map