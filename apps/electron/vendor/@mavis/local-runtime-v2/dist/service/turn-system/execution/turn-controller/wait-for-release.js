export async function waitForRelease(released, timeoutMs) {
    let timer;
    try {
        return await Promise.race([
            releasedResult(released),
            new Promise((resolve) => {
                timer = setTimeout(() => resolve(false), timeoutMs);
                timer.unref?.();
            }),
        ]);
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}
async function releasedResult(released) {
    await released;
    return true;
}
//# sourceMappingURL=wait-for-release.js.map