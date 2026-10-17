const DEFAULT_MAX_HEALTH_SAMPLES = 90;
/**
 * Main-owned bounded incident context for the Utility process.
 *
 * Health recording is memory-only and piggybacks on the existing 10-second
 * heartbeat. Disk output happens only for a feedback upload/runtime loss.
 * The rare LRU-close event is written immediately so a Utility that blocks
 * inside `FSWatcher.close()` cannot swallow the last useful fact.
 */
export class UtilityRuntimeDiagnosticRecorder {
    constructor(logger, maxHealthSamples = DEFAULT_MAX_HEALTH_SAMPLES) {
        this.logger = logger;
        this.maxHealthSamples = maxHealthSamples;
        this.healthSamples = [];
    }
    recordHealth(sample) {
        this.appendBounded(this.healthSamples, { ...sample }, this.maxHealthSamples);
    }
    recordSkillRegistryDiagnostic(diagnostic) {
        this.writeInfo(() => `[UtilityRuntimeDiagnostics] skill_registry ${JSON.stringify(diagnostic)}`);
    }
    writeSnapshot(reason) {
        this.writeInfo(() => `[UtilityRuntimeDiagnostics] snapshot ${JSON.stringify({
            reason,
            capturedAtMs: Date.now(),
            healthSamples: this.healthSamples,
        })}`);
    }
    reset() {
        this.healthSamples.length = 0;
    }
    /** Test/read-only snapshot; callers cannot mutate recorder state. */
    snapshot() {
        return {
            healthSamples: this.healthSamples.map((sample) => ({ ...sample })),
        };
    }
    appendBounded(target, item, limit) {
        target.push(item);
        if (target.length > limit)
            target.splice(0, target.length - limit);
    }
    writeInfo(formatMessage) {
        try {
            this.logger.info(formatMessage());
        }
        catch {
            // Diagnostic formatting and output are outside runtime control flow.
        }
    }
}

let targetLogger;
/** Main-process singleton with no logger/module initialization side effects. */
export let utilityRuntimeDiagnostics = new UtilityRuntimeDiagnosticRecorder({
    info(message) {
        targetLogger?.info(message);
    },
});
export function configureUtilityRuntimeDiagnosticsLogger(logger) {
    targetLogger = logger;
}
