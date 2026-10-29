// ── TUI presentation ─────────────────────────────────────────────
// ── TUI config parsing ──────────────────────────────────────────
/**
 * Parses TUI presentation settings.
 *
 * Item ids are validated by the TUI, not here: config only guarantees the shape
 * (array of non-empty strings). A malformed value falls back to `undefined` so
 * the TUI renders its build default rather than an empty line.
 */
export function parseTuiConfig(raw) {
    const rawTui = raw.tui;
    if (rawTui == null || typeof rawTui !== 'object' || Array.isArray(rawTui))
        return {};
    const tui = rawTui;
    const rawNotifications = tui.notifications;
    let notifications;
    if (rawNotifications &&
        typeof rawNotifications === 'object' &&
        !Array.isArray(rawNotifications)) {
        const { when, method, events } = rawNotifications;
        notifications = {
            ...(when === 'unfocused' || when === 'always' || when === 'never' ? { when } : {}),
            ...(method === 'auto' || method === 'osc9' || method === 'osc777' || method === 'bel'
                ? { method }
                : {}),
            ...(Array.isArray(events)
                ? {
                    events: events.filter((event) => typeof event === 'string'),
                }
                : {}),
        };
    }
    const rawStatusLine = tui.statusLine;
    const statusLine = Array.isArray(rawStatusLine)
        ? rawStatusLine
            .filter((item) => typeof item === 'string')
            .map((item) => item.trim())
            .filter(Boolean)
        : undefined;
    const customStatusLine = parseTuiCustomStatusLineConfig(tui.customStatusLine);
    return {
        ...(tui.terminalTitle === null
            ? { terminalTitle: null }
            : Array.isArray(tui.terminalTitle)
                ? {
                    terminalTitle: tui.terminalTitle
                        .filter((item) => typeof item === 'string')
                        .map((item) => item.trim())
                        .filter(Boolean),
                }
                : {}),
        ...(typeof tui.showTips === 'boolean' ? { showTips: tui.showTips } : {}),
        ...(typeof tui.programStatus === 'boolean' ? { programStatus: tui.programStatus } : {}),
        ...(notifications ? { notifications } : {}),
        ...(statusLine ? { statusLine } : {}),
        ...(customStatusLine ? { customStatusLine } : {}),
    };
}
/**
 * Parses the `custom-command` status item settings.
 *
 * A block without a usable `command` is dropped entirely: the TUI treats a
 * missing block as "item configured but inert", so partial or malformed config
 * can never spawn a process. Numeric bounds are enforced by the TUI, keeping
 * one owner for the clamping behaviour.
 */
function parseTuiCustomStatusLineConfig(value) {
    if (value == null || typeof value !== 'object' || Array.isArray(value))
        return undefined;
    const raw = value;
    const command = typeof raw.command === 'string' ? raw.command.trim() : '';
    if (!command)
        return undefined;
    return {
        command,
        ...(raw.display === 'inline' || raw.display === 'block' ? { display: raw.display } : {}),
        ...(raw.position === 'above' || raw.position === 'below' ? { position: raw.position } : {}),
        ...(raw.colorMode === 'plain' || raw.colorMode === 'ansi' ? { colorMode: raw.colorMode } : {}),
        ...(typeof raw.maxLines === 'number' && Number.isFinite(raw.maxLines)
            ? { maxLines: raw.maxLines }
            : {}),
        ...(typeof raw.timeoutMs === 'number' && Number.isFinite(raw.timeoutMs)
            ? { timeoutMs: raw.timeoutMs }
            : {}),
        ...(typeof raw.intervalSeconds === 'number' && Number.isFinite(raw.intervalSeconds)
            ? { intervalSeconds: raw.intervalSeconds }
            : {}),
    };
}
//# sourceMappingURL=tui-config.js.map