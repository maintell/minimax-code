let runtimeStartBlockCount = 0;
export function isUtilityRuntimeStartBlocked() {
    return runtimeStartBlockCount > 0;
}
export function blockUtilityRuntimeStart() {
    runtimeStartBlockCount += 1;
    let released = false;
    return () => {
        if (released)
            return;
        released = true;
        runtimeStartBlockCount = Math.max(0, runtimeStartBlockCount - 1);
    };
}
export function resetUtilityRuntimeStartBlockForTests() {
    runtimeStartBlockCount = 0;
}
