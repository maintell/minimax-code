import { startBackgroundLocalTask } from '../background-bash/index.js';
import { runForegroundLocalTask } from './execution/local-task-runner.js';
export function buildLocalTaskAdapter(host, parentSession) {
    return {
        runForeground: (toolCtx, taskInput, signal) => runForegroundLocalTask({ host, parentSession, toolCtx, taskInput, signal }),
        startBackground: (toolCtx, taskInput, signal) => startBackgroundLocalTask({ host, parentSession, toolCtx, taskInput, signal }),
    };
}
//# sourceMappingURL=initialize.js.map