/** Main-window presentation belongs to the operation lifecycle, independently of the overlay. */
export class CuaWindowHandoff {
    constructor(getWindow, platform = process.platform, onWindowError = () => undefined) {
        this.getWindow = getWindow;
        this.platform = platform;
        this.onWindowError = onWindowError;
    }
    async begin(turn) {
        if (!['win32', 'darwin'].includes(this.platform) || this.matches(turn.sessionId, turn.turnId))
            return;
        this.clear();
        const state = {
            turn: { ...turn },
            ownsMinimize: false,
            stopping: false,
            released: false,
            onRestore: () => {
                state.ownsMinimize = false;
            },
        };
        this.current = state;
        try {
            const window = await this.getWindow();
            if (this.current !== state ||
                state.stopping ||
                !window ||
                window.isDestroyed() ||
                !window.isVisible() ||
                window.isMinimized())
                return;
            state.window = window;
            window.on('restore', state.onRestore);
            state.ownsMinimize = true;
            window.minimize();
        }
        catch (error) {
            state.ownsMinimize = false;
            this.onWindowError(error);
        }
    }
    release(sessionId, turnId) {
        const state = this.current;
        if (!state ||
            (sessionId && state.turn.sessionId !== sessionId) ||
            (turnId && state.turn.turnId !== turnId))
            return;
        // Abort may release the lease before its HTTP response reaches the banner.
        if (state.stopping)
            state.released = true;
        else
            this.clear();
    }
    async stop(turn, abort) {
        const state = this.matches(turn.sessionId, turn.turnId) ? this.current : undefined;
        if (state)
            state.stopping = true;
        try {
            await abort();
        }
        catch (error) {
            if (state && this.current === state) {
                state.stopping = false;
                if (state.released)
                    this.clear();
            }
            throw error;
        }
        if (!state || this.current !== state)
            return;
        const window = state.window;
        const restore = state.ownsMinimize;
        this.clear();
        if (!restore || !window || window.isDestroyed() || !window.isMinimized())
            return;
        try {
            window.restore();
            window.focus();
        }
        catch (error) {
            // A presentation failure must not turn a successful abort into a retry.
            this.onWindowError(error);
        }
    }
    clear() {
        const state = this.current;
        this.current = undefined;
        state?.window?.removeListener('restore', state.onRestore);
    }
    matches(sessionId, turnId) {
        return this.current?.turn.sessionId === sessionId && this.current.turn.turnId === turnId;
    }
}

