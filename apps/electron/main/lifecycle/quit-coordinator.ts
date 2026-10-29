const RENDERER_ACK_TIMEOUT_MS = 12000;
const UPDATE_WINDOW_CLOSE_TIMEOUT_MS = 12000;
const CLEANUP_CUTOFF_MS = 16000;
export let INSTALLER_HANDOFF_TIMEOUT_MS = 30000;
// Best-effort budget for flushing buffered logs before a terminal exit. Kept
// short so a stuck log writer can never block process termination, but long
// enough for the fire-and-forget appendFile chain to land the final fatal
// evidence on an early-startup crash.
export let EXIT_LOG_FLUSH_TIMEOUT_MS = 1500;
/**
 * Keep the concrete Electron terminal calls in the coordinator owner while
 * allowing the production composition to inject the Electron instances.
 */
export function createElectronTerminalActionAdapters(input) {
    const { app, autoUpdater } = input;
    return {
        app: {
            quit: () => app.quit(),
            relaunch: (options) => app.relaunch(options
                ? {
                    ...(options.execPath === undefined ? {} : { execPath: options.execPath }),
                    ...(options.args === undefined ? {} : { args: [...options.args] }),
                }
                : undefined),
            exit: (code) => app.exit(code),
        },
        updater: {
            quitAndInstall: (isSilent, isForceRunAfter) => autoUpdater.quitAndInstall(isSilent, isForceRunAfter),
        },
    };
}
function deferred() {
    let resolve;
    const promise = new Promise((resolvePromise) => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}
function freezeRelaunchOptions(options) {
    if (!options)
        return undefined;
    const copied = {};
    if (options.execPath !== undefined)
        copied.execPath = options.execPath;
    if (options.args !== undefined) {
        copied.args = Object.freeze([...options.args]);
    }
    return Object.freeze(copied);
}
function freezeTerminalPlan(plan) {
    switch (plan.kind) {
        case 'exit':
            if (plan.code !== 0 && plan.code !== 1)
                throw new Error('Invalid terminal exit code');
            return Object.freeze({ kind: 'exit', code: plan.code });
        case 'relaunch':
            return Object.freeze({
                kind: 'relaunch',
                options: freezeRelaunchOptions(plan.options),
            });
        case 'install':
            if (typeof plan.isSilent !== 'boolean' || typeof plan.isForceRunAfter !== 'boolean') {
                throw new Error('Invalid installer terminal plan');
            }
            return Object.freeze({
                kind: 'install',
                installerPath: plan.installerPath,
                isSilent: plan.isSilent,
                isForceRunAfter: plan.isForceRunAfter,
            });
    }
}
function rejectedInstall(error) {
    return Object.freeze({ status: 'rejected', reason: 'invalid-install', error });
}
export class QuitCoordinator {
    constructor(dependencies) {
        this.beforeQuitHandled = false;
        this.rendererAckPending = false;
        this.rendererCloseCompleted = false;
        this.rendererAckOutcome = 'not-required';
        this.cleanupOutcome = 'failed';
        this.terminalStarted = false;
        this.installerFailureHandled = false;
        this.installerHandoffInFlight = false;
        this.exitCalled = false;
        this.shutdownObserved = false;
        this.dependencies = dependencies;
    }
    requestQuit(intent) {
        switch (intent.kind) {
            case 'normal':
                if (this.dependencies.confirmNormalQuit) {
                    if (this.owned)
                        return this.owned.promise;
                    return this.requestConfirmedNormalQuit(intent.source ?? 'unknown');
                }
                return this.claimPlan(this.resolveNormalPlan(), true, 'normal', intent.source ?? 'unknown');
            case 'relaunch':
                return this.claimPlan(freezeTerminalPlan({ kind: 'relaunch', options: intent.options }), true, 'relaunch', intent.source ?? 'unknown');
            case 'fatal':
                return this.claimPlan(freezeTerminalPlan({ kind: 'exit', code: 1 }), true, 'fatal', intent.source ?? 'unknown');
            case 'install-update':
                return this.resolveExplicitInstall(intent.source ?? 'unknown');
        }
    }
    failStartup(error) {
        this.logError('Lifecycle startup failed', error);
        return this.requestQuit({ kind: 'fatal', error, source: 'startup-fatal' });
    }
    onBeforeQuit(event) {
        if (!this.owned && this.dependencies.confirmNormalQuit && event) {
            event.preventDefault();
            void this.requestQuit({ kind: 'normal', source: 'external-before-quit' });
            return;
        }
        if (!this.owned) {
            this.claimPlan(this.resolveNormalPlan(), false, 'external', 'external-before-quit');
        }
        if (this.beforeQuitHandled)
            return;
        this.beforeQuitHandled = true;
        try {
            this.dependencies.beforeQuit?.();
        }
        catch (error) {
            this.logError('Failed to run quit coordinator beforeQuit hook', error);
        }
        try {
            this.dependencies.window.setAppQuitting(true);
        }
        catch (error) {
            this.logError('Failed to mark the primary window as quitting', error);
        }
        try {
            this.dependencies.kernel.runBeforeQuit();
        }
        catch (error) {
            this.logError('Lifecycle beforeQuit hooks failed', error);
        }
        this.armRendererAckTimer();
        this.armUpdateWindowCloseTimer();
    }
    confirmRendererQuit() {
        this.completeRendererAck('confirmed');
    }
    requestConfirmedNormalQuit(source) {
        if (this.normalQuitConfirmation) {
            try {
                this.dependencies.focusNormalQuitConfirmation?.();
            }
            catch (error) {
                this.logWarn('Failed to foreground the pending quit confirmation', error);
            }
            return this.normalQuitConfirmation;
        }
        // Defer the callback so a reentrant menu request sees the same pending gate.
        const confirmation = Promise.resolve().then(async () => {
            let confirmed = false;
            try {
                confirmed = (await this.dependencies.confirmNormalQuit?.()) === true;
            }
            catch (error) {
                this.logError('Failed to confirm normal quit; keeping the app open', error);
            }
            // A fatal/relaunch/install intent may have won while the dialog was open.
            if (this.owned)
                return this.owned.promise;
            if (!confirmed)
                return { status: 'rejected', reason: 'user-cancelled' };
            return this.claimPlan(this.resolveNormalPlan(), true, 'normal', source);
        });
        this.normalQuitConfirmation = confirmation;
        void confirmation.finally(() => {
            if (this.normalQuitConfirmation === confirmation)
                this.normalQuitConfirmation = undefined;
        });
        return confirmation;
    }
    onWillQuit(event) {
        // electron-updater calls app.quit() again after it has handed control to
        // the platform installer. Let that second will-quit proceed; cleanup and
        // the terminal action already ran before quitAndInstall(). The watchdog
        // remains armed so a handoff that never exits still fails closed.
        if (this.installerHandoffInFlight || this.installerFailureHandled)
            return;
        if (!this.owned)
            return;
        try {
            event.preventDefault();
        }
        catch (error) {
            this.logError('Failed to prevent Electron will-quit', error);
        }
        this.startCleanup();
    }
    resolveNormalPlan() {
        try {
            const plan = this.dependencies.updater.resolveNormalPlan();
            if (plan.kind === 'install' || (plan.kind === 'exit' && plan.code === 0)) {
                return freezeTerminalPlan(plan);
            }
            throw new Error(`Invalid normal terminal plan: ${plan.kind}`);
        }
        catch (error) {
            this.logWarn('Normal quit plan resolution failed; using exit 0', error);
            return freezeTerminalPlan({ kind: 'exit', code: 0 });
        }
    }
    resolveExplicitInstall(source) {
        let resolution;
        try {
            resolution = this.dependencies.updater.resolveExplicitInstallPlan();
        }
        catch (error) {
            this.logWarn('Explicit installer validation failed', error);
            return Promise.resolve(rejectedInstall(error));
        }
        return Promise.resolve(resolution).then((result) => {
            if (result.status !== 'valid')
                return rejectedInstall(result.error);
            try {
                if (result.plan.kind !== 'install')
                    throw new Error('Invalid explicit installer plan');
                return this.claimPlan(freezeTerminalPlan(result.plan), true, 'install-update', source);
            }
            catch (error) {
                this.logWarn('Explicit installer validation failed', error);
                return rejectedInstall(error);
            }
        }, (error) => {
            this.logWarn('Explicit installer validation failed', error);
            return rejectedInstall(error);
        });
    }
    claimPlan(plan, callAppQuit, intent, source) {
        if (this.owned)
            return this.owned.promise;
        const completion = deferred();
        this.owned = {
            plan,
            intent,
            source,
            startedAtMs: this.now(),
            promise: completion.promise,
            resolve: completion.resolve,
            settled: false,
        };
        this.logPlanClaim(this.owned);
        if (callAppQuit) {
            try {
                this.dependencies.app.quit();
            }
            catch (error) {
                this.logError('Electron app.quit failed; starting cleanup directly', error);
                this.startCleanup();
            }
        }
        return this.owned.promise;
    }
    armRendererAckTimer() {
        if (this.rendererAckPending || this.rendererCloseCompleted)
            return;
        let hasLivePrimary = false;
        try {
            hasLivePrimary = this.dependencies.window.hasLivePrimary();
        }
        catch (error) {
            this.rendererAckOutcome = 'failed';
            this.logError('Failed to inspect the primary window before quit', error);
            return;
        }
        if (!hasLivePrimary)
            return;
        this.rendererAckPending = true;
        this.rendererAckOutcome = 'not-received';
        this.rendererAckStartedAtMs = this.now();
        try {
            this.rendererAckTimer = this.dependencies.timers.setTimeout(() => this.completeRendererAck('timed-out'), RENDERER_ACK_TIMEOUT_MS);
        }
        catch (error) {
            this.rendererAckPending = false;
            this.rendererAckOutcome = 'failed';
            this.logError('Failed to arm the renderer quit acknowledgement timer', error);
        }
    }
    completeRendererAck(outcome) {
        if (!this.rendererAckPending || this.rendererCloseCompleted)
            return;
        this.rendererAckPending = false;
        this.rendererCloseCompleted = true;
        this.rendererAckOutcome = outcome;
        this.recordRendererAckDuration();
        this.clearRendererAckTimer();
        let hasLivePrimary = false;
        try {
            hasLivePrimary = this.dependencies.window.hasLivePrimary();
        }
        catch (error) {
            this.logError('Failed to inspect the primary window during quit acknowledgement', error);
            return;
        }
        if (!hasLivePrimary)
            return;
        try {
            this.dependencies.window.setForceQuit(true);
        }
        catch (error) {
            this.logError('Failed to force the primary window to quit', error);
        }
        try {
            this.dependencies.window.closePrimary();
        }
        catch (error) {
            this.logError('Failed to close the primary window during quit', error);
        }
    }
    recordRendererAckDuration() {
        if (this.rendererAckMs !== undefined || this.rendererAckStartedAtMs === undefined)
            return;
        this.rendererAckMs = Math.max(0, this.now() - this.rendererAckStartedAtMs);
    }
    clearRendererAckTimer() {
        if (this.rendererAckTimer === undefined)
            return;
        const timer = this.rendererAckTimer;
        this.rendererAckTimer = undefined;
        try {
            this.dependencies.timers.clearTimeout(timer);
        }
        catch (error) {
            this.logWarn('Failed to clear the renderer quit acknowledgement timer', error);
        }
    }
    armUpdateWindowCloseTimer() {
        // Only an explicitly requested update may force windows closed. A normal
        // quit can also resolve to an install plan (silent update on exit).
        if (this.owned?.intent !== 'install-update' || this.owned.plan.kind !== 'install')
            return;
        if (this.cleanupPromise || this.terminalStarted)
            return;
        try {
            this.updateWindowCloseTimer = this.dependencies.timers.setTimeout(() => this.forceCloseUpdateWindows(), UPDATE_WINDOW_CLOSE_TIMEOUT_MS);
        }
        catch (error) {
            this.logError('Failed to arm the update window close timeout', error);
            this.forceCloseUpdateWindows();
        }
    }
    forceCloseUpdateWindows() {
        if (this.cleanupPromise || this.terminalStarted)
            return;
        this.updateWindowCloseTimer = undefined;
        this.logWarn(`Update windows did not close within ${UPDATE_WINDOW_CLOSE_TIMEOUT_MS}ms; forcing close`);
        if (this.rendererAckPending) {
            this.rendererAckOutcome = 'timed-out';
            this.rendererAckPending = false;
            this.recordRendererAckDuration();
            this.clearRendererAckTimer();
        }
        try {
            this.dependencies.window.destroyAll();
        }
        catch (error) {
            this.logError('Failed to force update windows closed', error);
        }
        // A cancelled BrowserWindow.close() may have already aborted app.quit().
        // Destroying the window need not emit will-quit, so advance explicitly.
        this.startCleanup();
    }
    clearUpdateWindowCloseTimer() {
        if (this.updateWindowCloseTimer === undefined)
            return;
        const timer = this.updateWindowCloseTimer;
        this.updateWindowCloseTimer = undefined;
        try {
            this.dependencies.timers.clearTimeout(timer);
        }
        catch (error) {
            this.logWarn('Failed to clear the update window close timeout', error);
        }
    }
    startCleanup() {
        if (this.cleanupPromise)
            return;
        this.clearUpdateWindowCloseTimer();
        const completion = deferred();
        this.cleanupPromise = completion.promise;
        void this.executeCleanup().then(() => completion.resolve(), (error) => {
            this.logError('Unexpected quit coordinator cleanup failure', error);
            this.cleanupOutcome = 'failed';
            this.cleanupSummary = undefined;
            this.finalizeOwnedPlan();
            completion.resolve();
        });
    }
    async executeCleanup() {
        this.cleanupStartedAtMs = this.now();
        const abortController = new AbortController();
        const cutoff = deferred();
        let cutoffTimer;
        const forceCutoff = () => {
            if (abortController.signal.aborted)
                return;
            this.logWarn(`Lifecycle cleanup exceeded ${CLEANUP_CUTOFF_MS}ms; forcing terminal action`);
            try {
                abortController.abort(new Error(`Lifecycle cleanup exceeded ${CLEANUP_CUTOFF_MS}ms`));
            }
            catch (error) {
                this.logError('Failed to abort lifecycle cleanup at the cutoff', error);
            }
            cutoff.resolve('cutoff');
        };
        try {
            cutoffTimer = this.dependencies.timers.setTimeout(forceCutoff, CLEANUP_CUTOFF_MS);
        }
        catch (error) {
            this.logError('Failed to arm the lifecycle cleanup cutoff', error);
            forceCutoff();
        }
        let cleanup;
        try {
            cleanup = Promise.resolve(this.dependencies.kernel.disposeAll({ signal: abortController.signal })).then((summary) => ({ kind: 'settled', summary }), (error) => ({ kind: 'rejected', error }));
        }
        catch (error) {
            cleanup = Promise.resolve({ kind: 'rejected', error });
        }
        // Keep a side-channel result so an actual kernel can still publish the
        // partial aborted summary in the same turn as the global cutoff. A
        // disposer that ignores abort may never settle; in that case we retain an
        // explicit `cleanup_summary_available=false` signal instead of inventing
        // zero owner counts.
        let settledCleanup;
        void cleanup.then((result) => {
            settledCleanup = result;
        });
        const outcome = await Promise.race([cleanup, cutoff.promise]);
        if (outcome === 'cutoff') {
            this.cleanupOutcome = 'cutoff';
            // Abort handlers in LifecycleKernel resolve on the next microtask. Give
            // that already-triggered work one turn to publish its partial summary,
            // without waiting for arbitrary late disposers.
            await Promise.resolve();
            if (settledCleanup?.kind === 'settled') {
                this.cleanupSummary = settledCleanup.summary;
            }
            else {
                this.cleanupSummary = undefined;
            }
        }
        else {
            if (cutoffTimer !== undefined) {
                try {
                    this.dependencies.timers.clearTimeout(cutoffTimer);
                }
                catch (error) {
                    this.logWarn('Failed to clear the lifecycle cleanup cutoff', error);
                }
            }
            if (outcome.kind === 'rejected') {
                this.cleanupOutcome = 'failed';
                this.cleanupSummary = undefined;
                this.logError('Lifecycle cleanup failed', outcome.error);
            }
            else {
                this.cleanupSummary = outcome.summary;
                this.cleanupOutcome = this.isDegradedCleanup(outcome.summary) ? 'degraded' : 'clean';
            }
        }
        this.cleanupMs = Math.max(0, this.now() - this.cleanupStartedAtMs);
        this.rendererAckPending = false;
        this.recordRendererAckDuration();
        this.clearRendererAckTimer();
        this.finalizeOwnedPlan();
    }
    finalizeOwnedPlan() {
        if (this.terminalStarted || !this.owned)
            return;
        this.terminalStarted = true;
        switch (this.owned.plan.kind) {
            case 'exit':
                this.observeShutdown('dispatched');
                this.exitOnce(this.owned.plan.code);
                this.settleOwned('dispatched');
                return;
            case 'relaunch': {
                let terminalOutcome;
                try {
                    this.dependencies.app.relaunch(this.owned.plan.options);
                    terminalOutcome = 'dispatched';
                }
                catch (error) {
                    this.logError('Electron app.relaunch failed', error);
                    terminalOutcome = 'failed';
                }
                this.observeShutdown(terminalOutcome);
                this.exitOnce(terminalOutcome === 'dispatched' ? 0 : 1);
                this.settleOwned(terminalOutcome);
                return;
            }
            case 'install':
                this.startInstallerHandoff(this.owned.plan);
                return;
        }
    }
    startInstallerHandoff(plan) {
        this.logInstallerDiagnostic('Installer handoff starting', {
            installer_path: plan.installerPath,
            is_silent: plan.isSilent,
            force_run_after: plan.isForceRunAfter,
            cleanup_outcome: this.cleanupOutcome,
            cleanup_aborted: this.cleanupSummary?.aborted,
            unfinished_init_owners: this.cleanupSummary?.unfinishedInitOwners,
            unfinished_dispose_owners: this.cleanupSummary?.unfinishedDisposeOwners,
            cleanup_results: this.cleanupSummary?.results.map(({ name, status, durationMs }) => ({
                name,
                status,
                duration_ms: durationMs,
            })),
            renderer_ack: this.rendererAckOutcome,
        });
        this.installerHandoffStartedAtMs = this.now();
        try {
            this.installerHandoffTimer = this.dependencies.timers.setTimeout(() => this.failInstallerHandoff(plan, 'timeout'), INSTALLER_HANDOFF_TIMEOUT_MS);
        }
        catch (error) {
            this.observeShutdown('failed');
            this.failInstallerHandoff(plan, 'throw', error);
            this.settleOwned('failed');
            return;
        }
        this.installerHandoffInFlight = true;
        let terminalOutcome;
        try {
            this.dependencies.updater.quitAndInstall(plan.isSilent, plan.isForceRunAfter);
            terminalOutcome = 'dispatched';
            this.observeShutdown(terminalOutcome);
            this.observeInstallerHandoff('dispatched');
        }
        catch (error) {
            terminalOutcome = 'failed';
            this.observeShutdown(terminalOutcome);
            this.failInstallerHandoff(plan, 'throw', error);
        }
        this.settleOwned(terminalOutcome);
    }
    failInstallerHandoff(plan, reason, error) {
        if (this.installerFailureHandled)
            return;
        this.installerFailureHandled = true;
        this.installerHandoffInFlight = false;
        if (this.installerHandoffTimer !== undefined) {
            const timer = this.installerHandoffTimer;
            this.installerHandoffTimer = undefined;
            try {
                this.dependencies.timers.clearTimeout(timer);
            }
            catch (clearError) {
                this.logWarn('Failed to clear the installer handoff watchdog', clearError);
            }
        }
        const installerPath = plan.installerPath ?? '<unknown>';
        if (reason === 'timeout') {
            this.logError(`Installer handoff timed out after ${INSTALLER_HANDOFF_TIMEOUT_MS}ms for ${installerPath}`);
        }
        else {
            this.logError(`Installer handoff failed for ${installerPath}`, error);
        }
        this.observeInstallerHandoff(reason);
        this.exitOnce(1);
    }
    isDegradedCleanup(summary) {
        return (summary.aborted ||
            summary.unfinishedInitOwners.length > 0 ||
            summary.unfinishedDisposeOwners.length > 0 ||
            summary.results.some((result) => result.status !== 'disposed'));
    }
    observeShutdown(terminalOutcome) {
        if (this.shutdownObserved || !this.owned)
            return;
        this.shutdownObserved = true;
        try {
            this.dependencies.observeShutdown?.({
                intent: this.owned.intent,
                plan: this.owned.plan,
                cleanupOutcome: this.cleanupOutcome,
                cleanupSummary: this.cleanupSummary,
                rendererAck: this.rendererAckOutcome,
                terminalOutcome,
                durationMs: Math.max(0, this.now() - this.owned.startedAtMs),
                phases: {
                    ...(this.rendererAckMs === undefined ? {} : { rendererAckMs: this.rendererAckMs }),
                    ...(this.cleanupMs === undefined ? {} : { cleanupMs: this.cleanupMs }),
                },
            });
        }
        catch {
            // Telemetry must never become process control.
        }
    }
    observeInstallerHandoff(outcome) {
        const startedAtMs = this.installerHandoffStartedAtMs ?? this.now();
        this.logInstallerDiagnostic('Installer handoff result (not installation result)', {
            outcome,
            duration_ms: Math.max(0, this.now() - startedAtMs),
        });
        try {
            this.dependencies.observeInstallerHandoff?.({
                outcome,
                durationMs: Math.max(0, this.now() - startedAtMs),
            });
        }
        catch {
            // Telemetry must never become process control.
        }
    }
    now() {
        return this.dependencies.now?.() ?? Date.now();
    }
    logInstallerDiagnostic(message, fields) {
        try {
            this.dependencies.logger.info?.({
                app_instance_id: this.dependencies.appInstanceId,
                ts_ms: this.now(),
                pid: process.pid,
                ...fields,
            }, `[QuitCoordinator] ${message}`);
        }
        catch {
            // Diagnostic failures must not change the installer handoff.
        }
    }
    settleOwned(terminalOutcome) {
        if (!this.owned || this.owned.settled)
            return;
        this.owned.settled = true;
        this.owned.resolve(Object.freeze({
            status: 'accepted',
            plan: this.owned.plan,
            terminalOutcome,
        }));
    }
    exitOnce(code) {
        if (this.exitCalled)
            return;
        this.exitCalled = true;
        // Drain buffered async log writes before terminating so an early-startup
        // fatal still leaves its evidence on disk. A watchdog guarantees the
        // process exits even if the flush hangs or throws — termination is never
        // held hostage by logging.
        const doExit = () => {
            try {
                this.dependencies.app.exit(code);
            }
            catch (error) {
                this.logError(`Electron app.exit(${code}) failed`, error);
            }
        };
        const flush = this.dependencies.flushLogs;
        if (!flush) {
            doExit();
            return;
        }
        let exited = false;
        const exitOnce = () => {
            if (exited)
                return;
            exited = true;
            doExit();
        };
        let watchdog;
        try {
            watchdog = this.dependencies.timers.setTimeout(exitOnce, EXIT_LOG_FLUSH_TIMEOUT_MS);
        }
        catch (error) {
            this.logWarn('Failed to arm the exit log-flush watchdog', error);
            doExit();
            return;
        }
        const clearWatchdog = () => {
            if (watchdog === undefined)
                return;
            const timer = watchdog;
            watchdog = undefined;
            try {
                this.dependencies.timers.clearTimeout(timer);
            }
            catch {
                // best-effort
            }
        };
        void Promise.resolve()
            .then(() => flush())
            .catch(() => undefined)
            .finally(() => {
            clearWatchdog();
            exitOnce();
        });
    }
    logError(message, error) {
        try {
            if (error === undefined)
                this.dependencies.logger.error(message);
            else
                this.dependencies.logger.error(message, error);
        }
        catch {
            // Logging must not break terminal progress.
        }
    }
    logWarn(message, error) {
        try {
            if (error === undefined)
                this.dependencies.logger.warn(message);
            else
                this.dependencies.logger.warn(message, error);
        }
        catch {
            // Logging must not break terminal progress.
        }
    }
    logPlanClaim(owned) {
        try {
            this.dependencies.logger.info?.({
                ...(this.dependencies.appInstanceId
                    ? { app_instance_id: this.dependencies.appInstanceId }
                    : {}),
                intent: owned.intent,
                plan_kind: owned.plan.kind,
                trigger_source: owned.source,
            }, '[QuitCoordinator] Shutdown plan claimed');
        }
        catch {
            // Diagnostics must never block process termination.
        }
    }
}

