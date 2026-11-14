export function createRuntimePowerDemand(onChanged) {
    let activeTurnCount = 0;
    let activeScheduledJobCount = 0;
    let active = false;
    const publish = () => {
        const next = activeTurnCount > 0 || activeScheduledJobCount > 0;
        if (next === active)
            return;
        active = next;
        try {
            onChanged?.(next);
        }
        catch {
            // Power policy is best-effort and must never affect Turn or Scheduler behavior.
        }
    };
    return {
        setActiveTurnCount: (count) => {
            activeTurnCount = count;
            publish();
        },
        setActiveScheduledJobCount: (count) => {
            activeScheduledJobCount = count;
            publish();
        },
    };
}
//# sourceMappingURL=index.js.map