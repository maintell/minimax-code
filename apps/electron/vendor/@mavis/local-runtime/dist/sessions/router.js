import { deriveLocalRuntimeTurnOutcome } from '../runtime/host.js';
export class LegacyOpencodeDisabledError extends Error {
    constructor(sessionId) {
        super(`Legacy opencode runtime is disabled for session ${sessionId}.`);
        this.name = 'LegacyOpencodeDisabledError';
    }
}
export class LocalSessionRouter {
    runtimeHost;
    legacyOpencodeEnabled;
    telemetry;
    constructor(options) {
        this.runtimeHost = options.runtimeHost;
        this.legacyOpencodeEnabled = options.legacyOpencodeEnabled ?? (() => true);
        this.telemetry = options.telemetry;
    }
    routeSession(session) {
        if (session.runtime === 'pi-agent') {
            return { kind: 'pi-agent', session };
        }
        return {
            kind: 'legacy-opencode',
            session,
            enabled: this.legacyOpencodeEnabled(),
        };
    }
    assertLegacyEnabled(sessionId) {
        if (this.legacyOpencodeEnabled())
            return;
        this.telemetry?.({
            runtime: 'opencode',
            sessionId,
            phase: 'disabled',
            message: 'legacy_opencode_disabled',
        });
        throw new LegacyOpencodeDisabledError(sessionId);
    }
    getCachedContextUsageToolCalibration(input) {
        return this.runtimeHost.contextUsageRuntime.getCachedToolCalibration(input);
    }
    async startTurn(session, input) {
        const route = this.routeSession(session);
        if (route.kind === 'legacy-opencode') {
            this.assertLegacyEnabled(session.sessionId);
            throw new Error(`Legacy opencode session ${session.sessionId} must be streamed through LegacyOpencodeRuntime.`);
        }
        this.telemetry?.({
            runtime: 'pi-agent',
            sessionId: session.sessionId,
            turnId: input.turnId,
            phase: 'start',
        });
        try {
            const output = await this.runtimeHost.runTurn({
                ...input,
                sessionId: session.sessionId,
                workspaceDir: session.workspaceDir,
            });
            const outcome = deriveLocalRuntimeTurnOutcome(output.events);
            const turnFailed = outcome.status !== 'completed';
            this.telemetry?.({
                runtime: 'pi-agent',
                sessionId: session.sessionId,
                turnId: input.turnId,
                phase: turnFailed ? 'failure' : 'success',
                ...(turnFailed ? { message: outcome.errorMessage ?? `status_${outcome.status}` } : {}),
                ...(turnFailed && outcome.errorCode !== undefined ? { errorCode: outcome.errorCode } : {}),
            });
            return output;
        }
        catch (err) {
            this.telemetry?.({
                runtime: 'pi-agent',
                sessionId: session.sessionId,
                turnId: input.turnId,
                phase: 'failure',
                message: err instanceof Error ? err.message : String(err),
            });
            throw err;
        }
    }
}
//# sourceMappingURL=router.js.map