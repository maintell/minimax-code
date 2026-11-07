export function createSessionSendWaitGraph() {
    // caller -> target -> in-flight wait count. Counted, because one Session can
    // hold several synchronous sends to the same target at once and the first
    // release must not erase the others' edge.
    const edges = new Map();
    return {
        findCycle(callerSessionId, targetSessionId) {
            if (callerSessionId === targetSessionId)
                return [callerSessionId, targetSessionId];
            const seen = new Set([targetSessionId]);
            const stack = [
                { node: targetSessionId, path: [callerSessionId, targetSessionId] },
            ];
            while (stack.length > 0) {
                const current = stack.pop();
                if (!current)
                    break;
                for (const next of edges.get(current.node)?.keys() ?? []) {
                    if (next === callerSessionId)
                        return [...current.path, callerSessionId];
                    if (seen.has(next))
                        continue;
                    seen.add(next);
                    stack.push({ node: next, path: [...current.path, next] });
                }
            }
            return undefined;
        },
        register(callerSessionId, targetSessionId) {
            const targets = edges.get(callerSessionId) ?? new Map();
            targets.set(targetSessionId, (targets.get(targetSessionId) ?? 0) + 1);
            edges.set(callerSessionId, targets);
            let released = false;
            return () => {
                if (released)
                    return;
                released = true;
                const current = edges.get(callerSessionId);
                const remaining = (current?.get(targetSessionId) ?? 0) - 1;
                if (!current)
                    return;
                if (remaining > 0) {
                    current.set(targetSessionId, remaining);
                    return;
                }
                current.delete(targetSessionId);
                if (current.size === 0)
                    edges.delete(callerSessionId);
            };
        },
    };
}
//# sourceMappingURL=mavis-session-send-wait-graph.js.map