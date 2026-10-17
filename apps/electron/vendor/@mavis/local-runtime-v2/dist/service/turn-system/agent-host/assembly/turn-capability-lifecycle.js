/**
 * Owns the v2 execution/publication boundary. TurnSystem remains the authority
 * for session admission; this lifecycle leases the capability generation
 * captured by every accepted execution while allowing a newer generation to
 * publish atomically for subsequently admitted turns.
 */
export class AgentHostTurnCapabilityLifecycle {
    provider;
    publicationGate;
    inFlight = new Map();
    attach(provider) {
        if (this.provider)
            throw new Error('AgentHost turn capability provider is already attached');
        this.provider = provider;
        const activeTurnCount = () => this.inFlight.size;
        return {
            get activeTurnCount() {
                return activeTurnCount();
            },
            tryPublish: (publish) => this.tryPublish(publish),
        };
    }
    async acquire(input) {
        const provider = this.provider;
        const allowPendingPublication = [...this.inFlight.values()].some((turn) => turn.sessionId === input.sessionId);
        if (provider)
            await provider.waitUntilReady({ allowPendingPublication });
        const preparation = provider && input.captureCapabilities !== false
            ? await provider.prepareTurnCapabilities?.(input.signal)
            : undefined;
        await this.waitForPublication();
        // No await below this point: capture + registration is one JS critical section.
        input.beforeCapabilityCapture?.();
        const capabilities = provider && input.captureCapabilities !== false
            ? provider.captureTurnCapabilities(preparation)
            : undefined;
        if (capabilities)
            provider?.retainTurnCapabilities?.(capabilities);
        const token = {};
        const turn = {
            sessionId: input.sessionId,
            turnId: input.turnId,
            ...(capabilities ? { capabilities } : {}),
        };
        this.inFlight.set(token, turn);
        return {
            ...(capabilities ? { capabilities } : {}),
            release: () => this.release(token, turn),
        };
    }
    release(token, turn) {
        if (this.inFlight.get(token) !== turn)
            return false;
        this.inFlight.delete(token);
        if (turn.capabilities)
            this.provider?.releaseTurnCapabilities?.(turn.capabilities);
        if (this.inFlight.size === 0)
            this.provider?.onHostIdle();
        return true;
    }
    async waitForPublication() {
        for (;;) {
            const gate = this.publicationGate;
            if (!gate)
                return;
            await gate.promise;
        }
    }
    tryPublish(publish) {
        if (this.publicationGate)
            return undefined;
        const token = {};
        const startSignal = createDeferredSignal();
        const completion = runPublication(startSignal.promise, publish);
        const gate = this.settlePublication(token, completion);
        this.publicationGate = { token, promise: gate };
        startSignal.resolve();
        return completion;
    }
    async settlePublication(token, completion) {
        try {
            await completion;
        }
        catch {
            // The caller observes publication failure; execution admission only waits for settlement.
        }
        finally {
            if (this.publicationGate?.token === token) {
                this.publicationGate = undefined;
                if (this.inFlight.size === 0)
                    this.provider?.onHostIdle();
            }
        }
    }
}
async function runPublication(startSignal, publish) {
    await startSignal;
    await publish();
}
function createDeferredSignal() {
    let resolve;
    const promise = new Promise((accept) => {
        resolve = accept;
    });
    return { promise, resolve };
}
//# sourceMappingURL=turn-capability-lifecycle.js.map