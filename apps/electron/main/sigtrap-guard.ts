/**
 * Electron main-process SIGTRAP guard.
 *
 * Why this exists (2026-11-07 incident): when V8 runs out of heap, Electron
 * crashes on purpose with `brk #0`, which raises SIGTRAP. If *any* listener is
 * registered for SIGTRAP, libuv's signal handler consumes the signal and
 * returns normally, the interrupted `brk` instruction is re-executed, raises
 * SIGTRAP again, and the process spins at 100% CPU forever instead of dying —
 * no crash dump, no restart, just a hung window. `signal-exit` (pulled in by
 * `proper-lockfile`, `execa`, `write-file-atomic`, …) registers a whole list
 * of signals unconditionally at module load, with no opt-out, so the only
 * reliable defence is to refuse the registration in the main process.
 *
 * This must run before anything that could load such a dependency, so
 * `main/index.ts` imports it as its very first import. It is a no-op outside
 * the Electron main process (renderer, utility process, CLI/TUI, tests), which
 * are free to register whatever they like.
 *
 * The module deliberately has zero imports: importing the app logger here
 * would itself pull a dependency graph in before the guard is armed.
 */

/** Signals whose registration we refuse. Only SIGTRAP is fatal-crash relevant. */
const GUARDED_SIGNAL = 'SIGTRAP';
const REGISTRATION_METHODS = [
    'on',
    'addListener',
    'prependListener',
    'once',
    'prependOnceListener',
];
let installed = false;
const warned = new Set();
/** Pristine registration methods, kept so tests can fully uninstall the guard. */
const originals = new Map();
/** True only inside the Electron main (browser) process. */
export function isElectronMainProcess() {
    return process.versions.electron !== undefined && process.type === 'browser';
}
function warnOnce(key, message) {
    if (warned.has(key))
        return;
    warned.add(key);
    // console.warn, not the app logger: this module must stay import-free, and a
    // blocked registration is a rare diagnostic that must never throw.
    console.warn(`[SigtrapGuard] ${message}`);
}
/** First few stack frames outside this module, for attributing a blocked call. */
function describeCaller() {
    const stack = new Error('SIGTRAP registration').stack ?? '';
    const frames = stack
        .split('\n')
        .slice(1)
        .map((line) => line.trim())
        .filter((line) => !line.includes('sigtrap-guard'))
        .slice(0, 4);
    return frames.length > 0 ? frames.join(' <- ') : 'unknown caller';
}
function patchRegistrationMethod(method) {
    const original = process[method];
    if (typeof original !== 'function')
        return;
    if (!originals.has(method))
        originals.set(method, original);
    const guarded = function guardedRegistration(event, listener) {
        if (event === GUARDED_SIGNAL) {
            warnOnce('blocked', `refused a ${GUARDED_SIGNAL} listener from ${describeCaller()}`);
            // Callers such as signal-exit only check that the call did not throw.
            return this;
        }
        return original.call(this, event, listener);
    };
    Object.defineProperty(process, method, {
        configurable: true,
        writable: true,
        enumerable: false,
        value: guarded,
    });
}
/**
 * Arm the guard. Idempotent. Returns false when it declined to install because
 * this is not the Electron main process (unless `force` is set, which the unit
 * tests use to exercise the behaviour under plain Node).
 */
export function installSigtrapGuard(options = {}) {
    if (installed)
        return true;
    if (options.force !== true && !isElectronMainProcess())
        return false;
    installed = true;
    // Anything registered before us would defeat the guard; drop it.
    const existing = process.listeners(GUARDED_SIGNAL);
    if (existing.length > 0) {
        for (const listener of existing) {
            process.removeListener(GUARDED_SIGNAL, listener);
        }
        warnOnce('removed', `removed ${existing.length} pre-existing ${GUARDED_SIGNAL} listener(s) at install time`);
    }
    for (const method of REGISTRATION_METHODS)
        patchRegistrationMethod(method);
    return true;
}
/** Test seam: restore the pristine process methods and forget all state. */
export function resetSigtrapGuardForTests() {
    for (const [method, original] of originals) {
        Object.defineProperty(process, method, {
            configurable: true,
            writable: true,
            enumerable: false,
            value: original,
        });
    }
    originals.clear();
    installed = false;
    warned.clear();
}
installSigtrapGuard();
