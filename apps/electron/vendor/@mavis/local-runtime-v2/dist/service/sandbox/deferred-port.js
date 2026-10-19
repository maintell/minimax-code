import { createLocalBashOperations } from '@earendil-works/pi-coding-agent/tools';
import { nestedRuntimeGuardEnv } from '@mavis/shared/nested-runtime-guard';
import { initializeLocalBackgroundBashExecutor } from '../background-bash/index.js';
import { SandboxError } from './sandbox-errors.js';
import { sandboxErrorOutcome } from './observability/invocation-trace.js';
/**
 * Bridges the V1 tool graph constructed before the V2 service owner is ready.
 * An unbound disabled port preserves native execution; an enabled one fails closed.
 */
export function createDeferredLocalSandboxBashOperationsFactory(desiredEnabled, 
/** Carries the runtime's PATH shims into background bash; see ensureRmShim. */
envPolicy) {
    let current;
    const fallback = createUnavailableSandboxBashOperationsFactory(desiredEnabled);
    let executor;
    const port = {
        create: (input) => (current ?? fallback).create(input),
        execute: (input) => executor.execute(input),
        bind: (factory) => {
            current = factory;
        },
    };
    executor = initializeLocalBackgroundBashExecutor(port, envPolicy);
    return port;
}
/** Temporary owner adapter until the concrete operation factory is wired. */
function createUnavailableSandboxBashOperationsFactory(effectiveEnabled) {
    return {
        create: (input) => {
            if (effectiveEnabled()) {
                throw new SandboxError('SANDBOX_UNAVAILABLE', 'invocation', 'Sandbox Bash operations are unavailable');
            }
            const nativeOperations = createLocalBashOperations({
                parentDeathGuard: input.identity.operationClass !== 'direct_foreground',
            });
            // Unbound and disabled still has to report admission, or a background
            // task started through this fallback would stay `queued` forever.
            return {
                separatesOutputStreams: nativeOperations.separatesOutputStreams,
                exec: async (command, cwd, options) => {
                    await input.onPreflightComplete?.();
                    return nativeOperations.exec(command, cwd, options);
                },
            };
        },
    };
}
/** Build the single operations path shared by all local Bash operation classes. */
export function createSandboxBashOperationsFactory(service) {
    return {
        create: (input) => {
            const nativeOperations = createLocalBashOperations({
                parentDeathGuard: input.identity.operationClass !== 'direct_foreground',
            });
            return {
                separatesOutputStreams: nativeOperations.separatesOutputStreams,
                exec: async (command, cwd, options) => {
                    const lease = await service.beginInvocation({
                        identity: input.identity,
                        workspaceRoot: input.workspaceRoot,
                        cwd,
                    });
                    return executeObserved({
                        nativeOperations,
                        lease,
                        command,
                        cwd,
                        options,
                        ...(input.onPreflightComplete
                            ? { onPreflightComplete: input.onPreflightComplete }
                            : {}),
                    });
                },
            };
        },
    };
}
async function executeObserved(input) {
    const { nativeOperations, lease, command, cwd, options } = input;
    let wrapped;
    const processFacts = createProcessObserver(input);
    const signal = lease.sandboxed
        ? combineAbortSignals(options.signal, lease.signal)
        : options.signal;
    let outcome = {
        termination: 'unknown',
        reasonCode: 'EXECUTION_OUTCOME_UNKNOWN',
    };
    try {
        wrapped = await wrapInvocation(input, signal);
        await input.onPreflightComplete?.();
        lease.trace.stage('exec.requested');
        const result = await nativeOperations.exec(wrapped?.command ?? command, cwd, {
            ...options,
            signal,
            env: resolveChildEnv(input, wrapped),
            onProcessEvent: processFacts.observe,
        });
        outcome = exitOutcome(result.exitCode);
        return result;
    }
    catch (error) {
        outcome = executionFailureOutcome(error, processFacts, {
            signal,
            callerSignal: options.signal,
        });
        throw error;
    }
    finally {
        await lease.finish(wrapped?.handle, outcome);
    }
}
/**
 * Environment handed to the managed Bash child.
 *
 * The bash tool's spawnHook already applied the runtime boundary strip before
 * `exec` was called, so adding the parent marker here — the last writer of the
 * child environment — is what makes it unforgeable from inherited env.
 * Restricted to the effective `delete_guard` cage: that is the only mode where
 * the child can create the nested Runtime's lock/ownership files without being
 * able to remove them again.
 */
function resolveChildEnv(input, wrapped) {
    const base = wrapped?.env ?? input.options.env;
    if (!input.lease.sandboxed || input.lease.filesystemMode !== 'delete_guard')
        return base;
    return { ...base, ...nestedRuntimeGuardEnv() };
}
async function wrapInvocation(input, signal) {
    const { lease, command, cwd, options } = input;
    if (!lease.sandboxed)
        return undefined;
    try {
        const wrapped = await lease.backend.wrap({
            command,
            cwd,
            baseEnv: options.env ?? {},
            sandboxTempDir: lease.context.sandboxTempDir,
            abortSignal: signal,
            commandId: lease.srtCommandId,
            commandText: lease.srtCommandId,
            gitSafeDirectories: lease.context.git.safeDirectories,
            filesystem: lease.context.filesystem,
        });
        lease.trace.stage('invocation.wrapped', wrapped.observation ?? { wrap_policy: 'unknown' });
        return wrapped;
    }
    catch (error) {
        if (error instanceof SandboxError)
            throw error;
        throw new SandboxError('SANDBOX_WRAP_FAILED', 'pre-spawn', error instanceof Error ? error.message : 'Sandbox command wrapping failed');
    }
}
function createProcessObserver(input) {
    const facts = { spawned: false, spawnFailed: false, timedOut: false };
    const observe = (event) => {
        if (event.type === 'spawned')
            facts.spawned = true;
        if (event.type === 'spawn_failed')
            facts.spawnFailed = true;
        if (event.type === 'timeout')
            facts.timedOut = true;
        input.lease.trace.stage(event.type === 'spawned' ? 'process.started' : `process.${event.type}`, {
            process_role: event.processRole,
        });
        try {
            input.options.onProcessEvent?.(event);
        }
        catch {
            /* best effort */
        }
    };
    return Object.assign(facts, { observe });
}
function exitOutcome(exitCode) {
    if (exitCode === 0)
        return { termination: 'exited_zero', exitCode, reasonCode: 'PROCESS_EXITED_ZERO' };
    if (exitCode === null)
        return { termination: 'unknown', exitCode, reasonCode: 'PROCESS_SIGNAL_EXIT' };
    return { termination: 'exited_nonzero', exitCode, reasonCode: 'PROCESS_NONZERO_EXIT' };
}
function executionFailureOutcome(error, facts, signals) {
    if (signals.signal?.aborted)
        return {
            termination: 'aborted',
            reasonCode: signals.callerSignal?.aborted ? 'CALLER_ABORTED' : 'RUNTIME_SHUTDOWN',
        };
    if (facts.timedOut)
        return { termination: 'timed_out', reasonCode: 'PROCESS_TIMEOUT' };
    if (facts.spawnFailed)
        return { termination: 'spawn_failed', reasonCode: 'PROCESS_SPAWN_FAILED' };
    return { ...sandboxErrorOutcome(error), termination: facts.spawned ? 'unknown' : 'not_started' };
}
function combineAbortSignals(caller, service) {
    return caller ? AbortSignal.any([caller, service]) : service;
}
//# sourceMappingURL=deferred-port.js.map