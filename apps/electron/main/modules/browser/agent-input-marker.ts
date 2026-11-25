/**
 * Agent-injected input (CDP `Input.*`) can reach the page's
 * `before-input-event` / `before-mouse-event` like real input. While the
 * Agent controls a tab those hooks block the user, so the Agent's own events
 * are marked here and let through. A short grace period covers events Chromium
 * delivers just after the CDP command resolves.
 */
const AGENT_INPUT_GRACE_MS = 150;
const activeDepth = new WeakMap();
const lastEndedAt = new WeakMap();
export async function withAgentInput(webContents, run) {
    activeDepth.set(webContents, (activeDepth.get(webContents) ?? 0) + 1);
    try {
        return await run();
    }
    finally {
        const depth = (activeDepth.get(webContents) ?? 1) - 1;
        if (depth > 0)
            activeDepth.set(webContents, depth);
        else
            activeDepth.delete(webContents);
        lastEndedAt.set(webContents, Date.now());
    }
}
export function isAgentInputActive(webContents, now = Date.now()) {
    if ((activeDepth.get(webContents) ?? 0) > 0)
        return true;
    const endedAt = lastEndedAt.get(webContents);
    return endedAt !== undefined && now - endedAt <= AGENT_INPUT_GRACE_MS;
}
