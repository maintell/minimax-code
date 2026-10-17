export async function waitForLocalAbortTurnRelease(ctx, _sessionId, activeTurn, waitMs, pollMs) {
    if (!activeTurn)
        return;
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
        if (!ctx.sessionTurns.isCurrent(activeTurn))
            return;
        await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    if (!ctx.sessionTurns.isCurrent(activeTurn))
        return;
    await ctx.sessionTurns.forceFinish(activeTurn);
}
//# sourceMappingURL=abort-wait.js.map