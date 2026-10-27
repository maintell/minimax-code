export function admitBackgroundTask(host, abort) {
    return host.backgroundTasks.admit(abort);
}
export function drainBackgroundTasks(host) {
    return host.backgroundTasks.drain();
}
//# sourceMappingURL=lifecycle.js.map