import { WORKSPACE_GIT_NUMERIC_FIELDS, emitWorkspaceGitObservation, } from '@mavis/shared/runtime-transport';
function gitObservationNow() {
    try {
        return performance.now();
    }
    catch {
        return 0;
    }
}
export function addGitObservation(trace, field, value = 1) {
    if (trace && Number.isFinite(value))
        trace[field] = (trace[field] ?? 0) + Math.max(0, value);
}
export function measureGitRead(trace, field, run) {
    if (!trace)
        return run();
    const start = gitObservationNow();
    return (async () => {
        try {
            return await run();
        }
        finally {
            addGitObservation(trace, field, gitObservationNow() - start);
        }
    })();
}
/** Observation failures, including a rejected or pending sink, never change the operation. */
export async function observeGitRead(mode, observer, run) {
    if (!observer)
        return run();
    const trace = { schema: 1, mode, outcome: 'error' };
    for (const field of WORKSPACE_GIT_NUMERIC_FIELDS)
        trace[field] = 0;
    // Result-size fields are unknown until the business result exists.
    delete trace.changed_files;
    delete trace.result_untracked_files;
    const start = gitObservationNow();
    try {
        const result = await run(trace);
        trace.outcome = 'success';
        return result;
    }
    finally {
        trace.read_ms = Math.max(0, gitObservationNow() - start);
        emitWorkspaceGitObservation(observer, trace);
    }
}
export function gitWatcherErrorCode(error) {
    try {
        const code = error?.code;
        return typeof code === 'string' &&
            ['EACCES', 'EPERM', 'ENOENT', 'ENOSPC', 'EMFILE', 'ENFILE'].includes(code)
            ? code
            : 'unknown';
    }
    catch {
        return 'unknown';
    }
}
export function startGitCommandObservation(trace) {
    if (!trace)
        return 0;
    addGitObservation(trace, 'command_count');
    return gitObservationNow();
}
export function finishGitCommandObservation(trace, args, started) {
    if (!trace)
        return;
    const elapsed = gitObservationNow() - started;
    addGitObservation(trace, 'command_ms', elapsed);
    if (args[0] === 'status')
        addGitObservation(trace, 'status_ms', elapsed);
    if (args[0] === 'diff' && args.includes('--numstat'))
        addGitObservation(trace, 'numstat_ms', elapsed);
}
//# sourceMappingURL=git-read-observation.js.map