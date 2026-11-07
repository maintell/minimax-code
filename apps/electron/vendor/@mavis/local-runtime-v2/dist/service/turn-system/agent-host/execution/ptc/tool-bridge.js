import {} from './contracts.js';
import { PtcSubcallScheduler } from './subcall-scheduler.js';
export function createPtcToolBridge(options) {
    const byName = new Map();
    for (const tool of options.tools) {
        if (!isSafeToolName(tool.name) || byName.has(tool.name)) {
            throw new Error(`Invalid or duplicate PTC tool name: ${tool.name}`);
        }
        byName.set(tool.name, tool);
    }
    const scheduler = new PtcSubcallScheduler(options.maxConcurrentToolCalls);
    return {
        toolNames: [...byName.keys()],
        ...(options.describe ? { describe: options.describe } : {}),
        invoke: async (call) => {
            const tool = byName.get(call.name);
            if (!tool)
                throw new Error(`Tool is not available to PTC: ${call.name}`);
            return await scheduler.run(tool.executionMode, (signal) => options.execute({ ...call, signal }), call.signal);
        },
        stop: (reason) => scheduler.stop(new Error(`PTC stopped: ${reason}`)),
        drain: () => scheduler.drain(),
    };
}
function isSafeToolName(name) {
    return Boolean(name) && !['__proto__', 'constructor', 'prototype'].includes(name);
}
//# sourceMappingURL=tool-bridge.js.map