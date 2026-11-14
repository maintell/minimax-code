function log(logger, level, fields, message) {
    try {
        logger[level](fields, message);
    }
    catch {
        // Diagnostics must not affect startup, Session creation or the remote default.
    }
}
/**
 * `existing` counts as applied even without the flag: startup marks those devices, and a record
 * written by an older build never carried one.
 */
function readStoredRecord(value) {
    const record = value;
    const cohort = record?.cohort;
    if (cohort !== 'new' && cohort !== 'existing')
        return undefined;
    return { cohort, applied: cohort === 'existing' || record?.ptcRemoteApplied === true };
}
export function createRuntimePtcDefault() {
    let cohort = 'unknown';
    let applied = false;
    let context;
    let persist;
    const markApplied = (input) => {
        try {
            input.store.markApplied();
            applied = true;
            return true;
        }
        catch (error) {
            log(input.logger, 'warn', { reason: String(error) }, 'ptc remote applied mark failed');
            return false;
        }
    };
    return {
        cohort: () => cohort,
        applied: () => applied,
        decideCohort: (input) => {
            context = input;
            try {
                const stored = readStoredRecord(input.store.read());
                if (stored) {
                    cohort = stored.cohort;
                    applied = stored.applied;
                    return;
                }
                const existing = input.store.hasSessions() || input.readExplicitPtc() !== undefined;
                const record = {
                    cohort: existing ? 'existing' : 'new',
                    decidedAt: input.nowMs(),
                    appVersion: input.appVersion,
                    // An install that already holds Sessions or a saved switch never reads Apollo, so it is
                    // decided here and now.
                    ...(existing ? { ptcRemoteApplied: true } : {}),
                };
                cohort = record.cohort;
                applied = existing;
                persist = () => {
                    try {
                        input.store.writeIfAbsent(record);
                        persist = undefined;
                    }
                    catch (error) {
                        log(input.logger, 'warn', { reason: String(error) }, 'ptc device cohort write failed');
                    }
                };
                persist();
            }
            catch (error) {
                log(input.logger, 'warn', { reason: String(error) }, 'ptc device cohort read failed');
            }
        },
        retryCohortWrite: () => persist?.(),
        applyRemoteDefault: async (input) => {
            const started = context;
            // No startup decision means no store to read, which is the same "cannot tell" answer.
            if (!started)
                return 'none';
            // A record that never landed is written first, so the decision below reads the stored one.
            persist?.();
            const stored = readDevice(started);
            if (!stored)
                return 'none';
            if (stored.applied) {
                applied = true;
                return report(started, input, 'done');
            }
            const decision = decideApply(started, input);
            if (decision.kind === 'none')
                return 'none';
            if (decision.kind === 'write') {
                try {
                    await input.writeBetaPtc(decision.value);
                }
                catch (error) {
                    log(started.logger, 'warn', { reason: String(error) }, 'ptc remote default write failed');
                    return report(started, input, 'failed');
                }
            }
            // The mark lands after the switch, so a half-applied device reads the explicit value next
            // time and only completes the mark.
            if (!markApplied(started))
                return report(started, input, 'failed');
            return report(started, input, decision.kind === 'write' ? decision.applied : 'skip');
        },
    };
}
/** The stored device record, or undefined when it could not be read or is not there at all. */
function readDevice(input) {
    let value;
    try {
        value = input.store.read();
    }
    catch (error) {
        log(input.logger, 'warn', { reason: String(error) }, 'ptc remote apply read failed');
        return undefined;
    }
    const stored = readStoredRecord(value);
    if (!stored) {
        log(input.logger, 'warn', { reason: 'no device record' }, 'ptc remote apply skipped, device undecided');
    }
    return stored;
}
/**
 * A switch somebody already chose wins, and so does a device Apollo does not reach: both only need
 * the mark, so Apollo never looks at this device again.
 */
function decideApply(started, input) {
    let explicit;
    try {
        explicit = input.readExplicitPtc();
    }
    catch (error) {
        log(started.logger, 'warn', { reason: String(error) }, 'ptc remote apply config read failed');
        return { kind: 'none' };
    }
    const writes = explicit === undefined &&
        input.configured &&
        input.hit === true &&
        typeof input.value === 'boolean';
    if (!writes)
        return { kind: 'mark' };
    const value = input.value === true;
    return { kind: 'write', value, applied: value ? 'on' : 'off' };
}
/** One line per answer, so a rollout can be read back from an uploaded log. */
function report(input, answer, apply) {
    log(input.logger, 'info', { apply, version: answer.version ?? '', value: answer.value ?? null }, 'ptc remote default applied');
    return apply;
}
//# sourceMappingURL=ptc-default-state.js.map