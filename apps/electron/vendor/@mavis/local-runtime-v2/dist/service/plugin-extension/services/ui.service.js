import { validateSuggestionText } from '../sdk/prompt-suggestion.js';
import { ExtensionServiceError } from '../errors.js';
import { EXTENSION_QUOTAS, PerPluginRateLimiter } from './quota.js';
const TOAST_TONES = new Set(['secondary', 'success', 'warning', 'danger']);
const MAX_TOAST_LENGTH = 500;
/** A pane id is the plugin's own key; a title is one tab label. */
const MAX_PANE_ID_LENGTH = 200;
const MAX_PANE_TITLE_LENGTH = 200;
/** Open panes one plugin may have in one session. */
const MAX_PANES_PER_PLUGIN = 16;
const MAX_PROMPT_LENGTH = 100_000;
const PROMPT_FILL_MODES = new Set(['replace', 'append']);
const FILL_REFUSALS = new Set(['draft', 'modal']);
const SUGGEST_REFUSALS = new Set([
    'draft-not-empty',
    'turn-running',
    'dismissed',
    'no-turn',
]);
/**
 * The runtime's record of the pane tabs open in each session, the authority every renderer stream
 * starts from: a renderer that subscribes later (one opened after `session.start`, a reloaded
 * window, one back on the session) is told exactly which are open. `ctx.ui.open` adds
 * or retitles a tab, `ctx.ui.close` and the user's close remove it, and a plugin that stops being
 * active in the session takes its tabs with it. Kept in memory: a runtime restart re-runs
 * `session.start`, which reopens what the plugin opens there.
 */
export class ExtensionPaneRoster {
    /** `sessionId → pluginId\0id → entry`, in the order the tabs were first opened. */
    sessions = new Map();
    /**
     * Adds the tab, or retitles an open one; false, keeping nothing, when it would be the plugin's
     * pane past `MAX_PANES_PER_PLUGIN` in the session.
     */
    open(sessionId, entry) {
        const panes = this.sessions.get(sessionId) ?? new Map();
        const key = paneKey(entry.pluginId, entry.id);
        if (!panes.has(key)) {
            let owned = 0;
            for (const pane of panes.values())
                if (pane.pluginId === entry.pluginId)
                    owned += 1;
            if (owned >= MAX_PANES_PER_PLUGIN)
                return false;
        }
        panes.set(key, entry);
        this.sessions.set(sessionId, panes);
        return true;
    }
    close(sessionId, pluginId, id) {
        const panes = this.sessions.get(sessionId);
        panes?.delete(paneKey(pluginId, id));
        if (panes?.size === 0)
            this.sessions.delete(sessionId);
    }
    /** The plugin left the session: drops its tabs and returns them. */
    withdraw(sessionId, pluginId) {
        const panes = this.sessions.get(sessionId);
        const removed = [];
        for (const [key, entry] of panes ?? []) {
            if (entry.pluginId !== pluginId)
                continue;
            panes?.delete(key);
            removed.push(entry);
        }
        if (panes?.size === 0)
            this.sessions.delete(sessionId);
        return removed;
    }
    deleteSession(sessionId) {
        this.sessions.delete(sessionId);
    }
    list(sessionId) {
        return [...(this.sessions.get(sessionId)?.values() ?? [])];
    }
}
function paneKey(pluginId, id) {
    return `${pluginId}\u0000${id}`;
}
/** `ctx.ui` and `ctx.prompt`: validated on the main thread, delivered over the stream. */
export class ExtensionUiService {
    deps;
    toastQuota;
    constructor(deps) {
        this.deps = deps;
        this.toastQuota = new PerPluginRateLimiter(EXTENSION_QUOTAS.toast, deps.nowMs);
    }
    /** Over quota the toast is dropped; the call itself still succeeds. */
    async toast(callId, text, opts) {
        await this.deps.boundary.run({ callId, domain: 'ui', method: 'toast' }, async (invocation, detail) => {
            const tone = opts?.tone;
            if (typeof text !== 'string' || (tone !== undefined && !TOAST_TONES.has(tone))) {
                throw new ExtensionServiceError('ARGUMENT_INVALID', 'toast takes text and an optional tone');
            }
            const { pluginId, sessionId } = invocation.origin;
            const verdict = this.toastQuota.take(pluginId);
            if (verdict !== 'allowed') {
                detail.status = 'dropped';
                // The first drop of a run is diagnosed.
                if (verdict === 'dropped')
                    return;
                this.deps.diagnose({
                    code: 'toast.dropped',
                    message: `more than ${EXTENSION_QUOTAS.toast} toasts a minute; dropping until the window rolls`,
                    pluginId,
                    sessionId,
                });
                return;
            }
            this.deps.stream.emit({
                type: 'ui.toast',
                sessionId,
                pluginId,
                text: text.slice(0, MAX_TOAST_LENGTH),
                ...(tone ? { tone } : {}),
            });
        });
    }
    /**
     * Shows or updates the plugin's pane tab in the invocation's session. Allowed from any
     * Invocation; repeats are not deduplicated here, the renderer treats a known id as an update.
     * The roster keeps the tab for the snapshot of renderers that subscribe later, without `focus`.
     */
    async open(callId, options) {
        await this.deps.boundary.run({ callId, domain: 'ui', method: 'open' }, async (invocation) => {
            const { id, title, focus } = (isObject(options) ? options : {});
            if (!isPaneId(id) ||
                typeof title !== 'string' ||
                title.trim().length === 0 ||
                (focus !== undefined && typeof focus !== 'boolean')) {
                throw new ExtensionServiceError('ARGUMENT_INVALID', `ui.open takes { id, title, focus?: boolean }: a non-empty id of at most ${MAX_PANE_ID_LENGTH} characters and a non-empty title`);
            }
            const { pluginId, sessionId } = invocation.origin;
            const entry = { pluginId, id, title: title.slice(0, MAX_PANE_TITLE_LENGTH) };
            if (!this.deps.panes.open(sessionId, entry)) {
                throw new ExtensionServiceError('ARGUMENT_INVALID', `ui.open: ${MAX_PANES_PER_PLUGIN} panes of this plugin are already open in this conversation; close one with ctx.ui.close(id) first`);
            }
            this.deps.stream.emit({
                type: 'ui.open',
                sessionId,
                ...entry,
                ...(focus === undefined ? {} : { focus }),
            });
        });
    }
    /** Removes the plugin's pane tab; the renderer does not report it back as `ui.close`. */
    async close(callId, id) {
        await this.deps.boundary.run({ callId, domain: 'ui', method: 'close' }, async (invocation) => {
            if (!isPaneId(id)) {
                throw new ExtensionServiceError('ARGUMENT_INVALID', `ui.close takes the pane id: a non-empty string of at most ${MAX_PANE_ID_LENGTH} characters`);
            }
            const { pluginId, sessionId } = invocation.origin;
            this.deps.panes.close(sessionId, pluginId, id);
            this.deps.stream.emit({ type: 'ui.close', sessionId, pluginId, id });
        });
    }
    /**
     * Replaces or appends to the composer draft of the invocation's own session; never confirms or
     * submits. Any Invocation may ask, a drawing included; the renderer, which alone sees the draft
     * and open dialogs, decides whether the draft takes it, and the audit row keeps that verdict,
     * never the text.
     */
    async fill(callId, args) {
        return this.deps.boundary.run({ callId, domain: 'prompt', method: 'fill' }, async (invocation, detail) => {
            const { text, mode = 'replace' } = (args ?? {});
            if (typeof text !== 'string' ||
                text.length > MAX_PROMPT_LENGTH ||
                !PROMPT_FILL_MODES.has(mode)) {
                throw new ExtensionServiceError('ARGUMENT_INVALID', "prompt.fill takes { text, mode?: 'replace' | 'append' }");
            }
            const result = fillResult(await this.deps.query.ask({
                sessionId: invocation.origin.sessionId,
                op: 'composer.fill',
                composerFill: { text, mode: mode },
                ...signalOf(invocation),
            }));
            detail.reason = result.written ? 'written' : result.reason;
            if (!result.written)
                detail.status = 'dropped';
            return result;
        });
    }
    /**
     * Offers text as the composer's suggestion. The renderer decides whether it took the slot; the
     * audit row keeps that verdict, never the text.
     */
    async suggest(callId, args) {
        return this.deps.boundary.run({ callId, domain: 'prompt', method: 'suggest' }, async (invocation, detail) => {
            const text = validateSuggestionText(args);
            const result = suggestResult(await this.deps.query.ask({
                sessionId: invocation.origin.sessionId,
                op: 'composer.suggest',
                composerSuggest: { text },
                ...signalOf(invocation),
            }));
            detail.reason = result.isShown ? 'shown' : result.reason;
            if (!result.isShown)
                detail.status = 'dropped';
            return result;
        });
    }
    /** The composer draft of the invocation's own session; the audit row never keeps it. */
    async read(callId) {
        return this.deps.boundary.run({ callId, domain: 'prompt', method: 'read' }, async (invocation) => {
            const answer = await this.deps.query.ask({
                sessionId: invocation.origin.sessionId,
                op: 'composer.read',
                ...signalOf(invocation),
            });
            if (answer.kind === 'composer.read')
                return { text: answer.draft };
            throw new ExtensionServiceError('PROMPT_READ_UNAVAILABLE', 'the composer did not answer in time');
        });
    }
}
function isObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isPaneId(value) {
    return typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_PANE_ID_LENGTH;
}
function signalOf(invocation) {
    return invocation.signal ? { signal: invocation.signal } : {};
}
/** A renderer that is not there, or cannot answer, is the same to the author: no composer. */
function fillResult(answer) {
    if (answer.kind !== 'composer.fill')
        return { written: false, reason: 'no-composer' };
    if (answer.written)
        return { written: true };
    return {
        written: false,
        reason: FILL_REFUSALS.has(answer.reason) ? answer.reason : 'no-composer',
    };
}
/** A renderer that is not there, or cannot answer, is the same to the author: no composer. */
function suggestResult(answer) {
    if (answer.kind !== 'composer.suggest')
        return { isShown: false, reason: 'no-composer' };
    if (answer.shown)
        return { isShown: true };
    return {
        isShown: false,
        reason: SUGGEST_REFUSALS.has(answer.reason)
            ? answer.reason
            : 'no-composer',
    };
}
//# sourceMappingURL=ui.service.js.map