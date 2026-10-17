const POISONED_PAGE_CONTEXT_ERROR = 'BROWSER_SESSION_POISONED: Browser recovery could not isolate the previous action; open a new Browser tab and inspect it before continuing';
/**
 * Owns the steady-state Browser Core session lifecycle for one Electron page.
 *
 * The transport is borrowed from the Electron controller. Disposing this
 * context releases only Browser Core listeners; transport detach/close stays
 * with the controller that created the debugger attachment.
 */
export class ElectronBrowserPageContext {
    constructor(options) {
        this.options = options;
        this.lifecycleBound = false;
        this.disposed = false;
        this.poisoned = false;
        this.handleDestroyed = () => {
            this.dispose();
        };
    }
    get transport() {
        return this.options.coreSession.transport;
    }
    get isDisposed() {
        return this.disposed;
    }
    bindLifecycle() {
        if (this.lifecycleBound || this.disposed)
            return;
        this.lifecycleBound = true;
        this.options.webContents.once('destroyed', this.handleDestroyed);
    }
    synchronizeGeneration(generation) {
        this.assertUsable();
        this.options.coreSession.synchronizeGeneration(generation);
    }
    resolveOpaqueRef(ref) {
        this.assertUsable();
        return this.options.coreSession.resolveOpaqueRef(ref);
    }
    resolveOpaqueTarget(ref) {
        this.assertUsable();
        return this.options.coreSession.resolveOpaqueTarget(ref);
    }
    resolveFrameRef(frameId) {
        this.assertUsable();
        return this.options.coreSession.resolveFrameRef(frameId);
    }
    async execute(action, input, signal) {
        this.assertUsable();
        try {
            return await this.options.coreSession.execute(action, input, signal);
        }
        catch (error) {
            // Recreating only the Core sidecar on the same transport would allow an
            // unsettled action to overlap a new session. Keep the poison sticky until
            // this WebContents is destroyed; callers can recover through open_tab
            // without automatically closing the user's visible page.
            if (this.options.coreSession.requiresRecreation)
                this.poisoned = true;
            throw error;
        }
    }
    assertUsable() {
        if (this.poisoned)
            throw new Error(POISONED_PAGE_CONTEXT_ERROR);
    }
    dispose() {
        if (this.disposed)
            return;
        this.disposed = true;
        if (this.lifecycleBound) {
            this.options.webContents.removeListener('destroyed', this.handleDestroyed);
            this.lifecycleBound = false;
        }
        try {
            this.options.coreSession.dispose();
        }
        finally {
            this.options.onDisposed?.();
        }
    }
}

