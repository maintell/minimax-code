/** Runs only product-owned handlers registered in code. No filesystem or command hooks. */
import { logger, getMetricsReporter } from './host-utils.js';
const log = logger.child({ module: 'hook-registry' });
export class HookRegistry {
    builtinHooks = [];
    registerBuiltin(registration) {
        const idx = this.builtinHooks.findIndex((r) => r.id === registration.id);
        const stored = registration;
        if (idx >= 0) {
            this.builtinHooks[idx] = stored;
        }
        else {
            this.builtinHooks.push(stored);
        }
    }
    async execute(hookEvent, input, output, matchValue, agentName) {
        const startMs = Date.now();
        const result = {
            output,
            aborted: false,
            executedCount: 0,
            errors: [],
        };
        const all = this.builtinHooks;
        const registrations = all.filter((r) => r.hookEvent === hookEvent);
        if (registrations.length === 0) {
            return result;
        }
        // Filter by agent name
        let filtered = registrations.filter((r) => {
            if (!agentName)
                return true;
            if (!r.agentName || r.agentName === '*')
                return true;
            return r.agentName === agentName;
        });
        // Filter by matcher regex
        if (matchValue !== undefined) {
            const beforeCount = filtered.length;
            filtered = filtered.filter((r) => {
                if (!r.matcher || r.matcher === '*' || r.matcher === '')
                    return true;
                try {
                    const re = new RegExp(r.matcher);
                    const matched = re.test(matchValue);
                    if (!matched) {
                        log.info({ hookId: r.id, matcher: r.matcher, matchValue }, '[hook-registry] matcher did not match, hook filtered out');
                    }
                    return matched;
                }
                catch {
                    log.warn({ hookId: r.id, matcher: r.matcher }, 'Invalid matcher regex, skipping hook');
                    return false;
                }
            });
            if (filtered.length < beforeCount) {
                log.info({ hookEvent, matchValue, beforeCount, afterCount: filtered.length }, '[hook-registry] hooks filtered by matcher');
            }
        }
        // Sort by priority ascending (lower = first)
        const sorted = [...filtered].sort((a, b) => a.priority - b.priority);
        // Execute hooks sequentially with error isolation
        for (const hook of sorted) {
            try {
                await this.executeWithTimeout(hook, input, output);
                result.executedCount++;
                // Check abort after each hook
                if (output._abort) {
                    result.aborted = true;
                    result.abortReason = output._abort.reason;
                    log.info({ hookEvent, hookId: hook.id, reason: output._abort.reason }, 'Hook chain aborted');
                    break;
                }
            }
            catch (err) {
                const error = err instanceof Error ? err : new Error(String(err));
                result.errors.push({ hookId: hook.id, error });
                result.executedCount++;
                log.warn({ hookEvent, hookId: hook.id, err: error.message }, 'Hook execution failed, continuing chain');
                // Error isolation: continue to next hook
            }
        }
        const hookResult = result.errors.length > 0 ? 'failure' : result.aborted ? 'skipped' : 'success';
        getMetricsReporter().incr('hook_execution_total', {
            hook_event: hookEvent,
            result: hookResult,
        });
        getMetricsReporter().latency('hook_execution_duration_ms', Date.now() - startMs, {
            hook_event: hookEvent,
        });
        return result;
    }
    executeWithTimeout(hook, input, output) {
        const { timeout, handler, id } = hook;
        return new Promise((resolve, reject) => {
            const ac = new AbortController();
            const timer = setTimeout(() => {
                ac.abort();
                reject(new Error(`Hook '${id}' timed out after ${timeout}ms`));
            }, timeout);
            handler(input, output)
                .then(() => {
                clearTimeout(timer);
                if (!ac.signal.aborted) {
                    resolve();
                }
            })
                .catch((err) => {
                clearTimeout(timer);
                if (!ac.signal.aborted) {
                    reject(err);
                }
            });
        });
    }
}
//# sourceMappingURL=hook-registry.js.map