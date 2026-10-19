const RENDERER_INCIDENT_WINDOW_MS = 60000;
const FORCED_RELOAD_PROCESS_EXIT_GRACE_MS = 10000;
const FORCED_RENDERER_EXIT_WAIT_MS = 2000;
const AUTO_RELOAD_REASONS = new Set(['crashed', 'oom', 'unresponsive', 'resume-health-failure']);
export class RendererIncidentController {
    constructor(dependencies) {
        this.dependencies = dependencies;
        this.attachments = new Map();
        this.nextGeneration = 1;
    }
    attach(window) {
        const existing = this.attachments.get(window.id);
        if (existing?.window === window)
            return;
        if (existing)
            this.detach(existing);
        const attachment = {
            window,
            generation: this.nextGeneration++,
            activeFlowHard: false,
            dialogInFlight: false,
            onUnresponsive: () => {
                void this.report(window, 'unresponsive', 'unresponsive');
            },
            onRenderProcessGone: (_event, details) => {
                void this.report(window, 'render-process-gone', details.reason, details.exitCode);
            },
            onDestroyed: () => {
                const current = this.attachments.get(window.id);
                if (current)
                    this.detach(current);
            },
        };
        this.attachments.set(window.id, attachment);
        window.on('unresponsive', attachment.onUnresponsive);
        window.webContents.on('render-process-gone', attachment.onRenderProcessGone);
        window.webContents.on('destroyed', attachment.onDestroyed);
    }
    reportResumeFailure(window) {
        return this.report(window, 'resume-health-failure', 'resume-health-failure');
    }
    disposeForTests() {
        for (const attachment of [...this.attachments.values()])
            this.detach(attachment);
    }
    report(window, kind, reason, exitCode) {
        const attachment = this.attachments.get(window.id);
        if (!attachment || attachment.window !== window)
            return Promise.resolve();
        const incident = {
            kind,
            occurredAtMs: this.dependencies.now(),
            windowId: window.id,
            reason,
            ...(exitCode === undefined ? {} : { exitCode }),
        };
        this.observe(incident);
        if (this.consumeExpectedProcessGone(attachment, incident)) {
            this.observeHandling(incident, 'ignored-expected', false);
            return Promise.resolve();
        }
        if (reason === 'clean-exit') {
            this.observeHandling(incident, 'ignored-clean', false);
            return Promise.resolve();
        }
        if (this.dependencies.isShuttingDown()) {
            this.observeHandling(incident, 'ignored-shutdown', false);
            return Promise.resolve();
        }
        if (!this.dependencies.isWindowAlive(window)) {
            this.observeHandling(incident, 'ignored-window-gone', false);
            return Promise.resolve();
        }
        const hardIncident = !AUTO_RELOAD_REASONS.has(incident.reason);
        if (attachment.activeFlow) {
            // A hard renderer failure must not wait behind a pending soft reload.
            // It is the one escalation that is allowed to join the existing flow
            // without being dropped; subsequent soft incidents still coalesce.
            if (!hardIncident || attachment.activeFlowHard) {
                this.observeHandling(incident, 'coalesced', this.isRepeatWithinWindow(attachment, incident));
                return attachment.activeFlow;
            }
            if (attachment.dialogInFlight) {
                attachment.activeFlowHard = true;
                this.observeHandling(incident, 'coalesced', this.isRepeatWithinWindow(attachment, incident));
                return attachment.activeFlow;
            }
            const previousFlow = attachment.activeFlow;
            const escalation = this.runRecovery(attachment, incident);
            const combined = Promise.all([previousFlow, escalation]).then(() => undefined);
            attachment.activeFlow = combined;
            attachment.activeFlowHard = true;
            void combined.finally(() => {
                if (attachment.activeFlow === combined) {
                    attachment.activeFlow = undefined;
                    attachment.activeFlowHard = false;
                }
            });
            return combined;
        }
        const flow = this.runRecovery(attachment, incident);
        attachment.activeFlow = flow;
        attachment.activeFlowHard = hardIncident;
        void flow.finally(() => {
            if (attachment.activeFlow === flow) {
                attachment.activeFlow = undefined;
                attachment.activeFlowHard = false;
            }
        });
        return flow;
    }
    async runRecovery(attachment, incident) {
        if (AUTO_RELOAD_REASONS.has(incident.reason)) {
            const lastReloadAtMs = attachment.lastAutoReloadAtMs;
            if (lastReloadAtMs === undefined ||
                incident.occurredAtMs - lastReloadAtMs >= RENDERER_INCIDENT_WINDOW_MS) {
                attachment.lastAutoReloadAtMs = incident.occurredAtMs;
                this.observeHandling(incident, 'auto-reload', false);
                await this.reloadIfCurrent(attachment, incident);
                return;
            }
            this.observeHandling(incident, 'dialog', true);
        }
        else {
            this.observeHandling(incident, 'dialog', false);
        }
        await this.showDialogIfCurrent(attachment, incident);
    }
    async reloadIfCurrent(attachment, incident) {
        if (!this.isCurrentAndRecoverable(attachment))
            return;
        const startedAtMs = this.dependencies.now();
        try {
            await this.reloadWindow(attachment, incident);
            this.observeRecovery(incident, 'reload', 'dispatched', startedAtMs);
        }
        catch (error) {
            this.observeRecovery(incident, 'reload', 'failed', startedAtMs);
            this.logError('[RendererIncidentController] Recovery action failed', error);
        }
    }
    async showDialogIfCurrent(attachment, incident) {
        if (!this.isCurrentAndRecoverable(attachment) || attachment.dialogInFlight)
            return;
        attachment.dialogInFlight = true;
        const generation = attachment.generation;
        const invokeIfCurrent = (action, actionName, failureMessage, actionState) => {
            if (actionState.taken ||
                !this.isCurrentAndRecoverable(attachment) ||
                attachment.generation !== generation) {
                return;
            }
            actionState.taken = true;
            const startedAtMs = this.dependencies.now();
            try {
                const result = action();
                // Exactly one terminal outcome per action: `dispatched` only after the
                // action settles successfully, `failed` on rejection. This keeps the
                // event model consistent with the auto-reload path so a dashboard can
                // count rows without deduplication.
                void Promise.resolve(result).then(() => {
                    this.observeRecovery(incident, actionName, 'dispatched', startedAtMs);
                }, (error) => {
                    this.observeRecovery(incident, actionName, 'failed', startedAtMs);
                    this.logError(failureMessage, error);
                });
            }
            catch (error) {
                this.observeRecovery(incident, actionName, 'failed', startedAtMs);
                this.logError(failureMessage, error);
            }
        };
        const actionState = { taken: false };
        try {
            await this.dependencies.showDialog({
                window: attachment.window,
                incident,
                onReload: () => invokeIfCurrent(() => this.reloadWindow(attachment, incident), 'reload', '[RendererIncidentController] Recovery action failed', actionState),
                onRestart: () => invokeIfCurrent(() => this.dependencies.requestRelaunch(attachment.window, incident), 'relaunch', '[RendererIncidentController] Relaunch request failed', actionState),
            });
        }
        catch (error) {
            this.logError('[RendererIncidentController] Incident dialog failed', error);
        }
        finally {
            attachment.dialogInFlight = false;
        }
    }
    async reloadWindow(attachment, incident) {
        const forceCrash = this.dependencies.forceCrash;
        if (incident.reason !== 'unresponsive' || !forceCrash) {
            await this.dependencies.reload(attachment.window, incident);
            return;
        }
        let resolveForcedExit;
        const forcedExit = new Promise((resolve) => {
            resolveForcedExit = resolve;
        });
        const expectedProcessGone = {
            untilMs: this.dependencies.now() + FORCED_RELOAD_PROCESS_EXIT_GRACE_MS,
            resolve: resolveForcedExit,
        };
        attachment.expectedProcessGone = expectedProcessGone;
        let timeout;
        try {
            forceCrash(attachment.window, incident);
            await Promise.race([
                forcedExit,
                new Promise((resolve) => {
                    timeout = setTimeout(resolve, FORCED_RENDERER_EXIT_WAIT_MS);
                }),
            ]);
            if (this.isCurrentAndRecoverable(attachment)) {
                await this.dependencies.reload(attachment.window, incident);
            }
        }
        finally {
            if (timeout)
                clearTimeout(timeout);
            if (attachment.expectedProcessGone === expectedProcessGone) {
                attachment.expectedProcessGone = undefined;
                expectedProcessGone.resolve();
            }
        }
    }
    consumeExpectedProcessGone(attachment, incident) {
        const expectedProcessGone = attachment.expectedProcessGone;
        if (!expectedProcessGone)
            return false;
        if (incident.occurredAtMs > expectedProcessGone.untilMs) {
            attachment.expectedProcessGone = undefined;
            expectedProcessGone.resolve();
            return false;
        }
        if (incident.kind !== 'render-process-gone' ||
            (incident.reason !== 'killed' && incident.reason !== 'crashed')) {
            return false;
        }
        attachment.expectedProcessGone = undefined;
        expectedProcessGone.resolve();
        return true;
    }
    isCurrentAndRecoverable(attachment) {
        return (this.attachments.get(attachment.window.id) === attachment &&
            !this.dependencies.isShuttingDown() &&
            this.dependencies.isWindowAlive(attachment.window));
    }
    isRepeatWithinWindow(attachment, incident) {
        return (attachment.lastAutoReloadAtMs !== undefined &&
            incident.occurredAtMs - attachment.lastAutoReloadAtMs < RENDERER_INCIDENT_WINDOW_MS);
    }
    observe(incident) {
        try {
            this.dependencies.observeIncident(incident);
        }
        catch (error) {
            this.logError('[RendererIncidentController] Incident observation failed', error);
        }
    }
    observeHandling(incident, handling, repeatWithinWindow) {
        try {
            this.dependencies.observeIncidentHandling?.({
                incident,
                handling,
                repeatWithinWindow,
            });
        }
        catch (error) {
            this.logError('[RendererIncidentController] Incident telemetry failed', error);
        }
    }
    observeRecovery(incident, action, outcome, startedAtMs) {
        try {
            this.dependencies.observeRecoveryResult?.({
                incident,
                action,
                outcome,
                durationMs: Math.max(0, this.dependencies.now() - startedAtMs),
            });
        }
        catch (error) {
            this.logError('[RendererIncidentController] Recovery telemetry failed', error);
        }
    }
    detach(attachment) {
        if (this.attachments.get(attachment.window.id) !== attachment)
            return;
        this.attachments.delete(attachment.window.id);
        attachment.generation = this.nextGeneration++;
        const expectedProcessGone = attachment.expectedProcessGone;
        attachment.expectedProcessGone = undefined;
        expectedProcessGone?.resolve();
        attachment.activeFlow = undefined;
        attachment.activeFlowHard = false;
        attachment.dialogInFlight = false;
        try {
            attachment.window.removeListener('unresponsive', attachment.onUnresponsive);
            attachment.window.webContents.removeListener('render-process-gone', attachment.onRenderProcessGone);
            attachment.window.webContents.removeListener('destroyed', attachment.onDestroyed);
        }
        catch (error) {
            this.logError('[RendererIncidentController] Failed to detach window listeners', error);
        }
    }
    logError(message, error) {
        try {
            this.dependencies.logger.error(message, error);
        }
        catch {
            // Recovery progress must not depend on logging availability.
        }
    }
}

