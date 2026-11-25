/** Carries the metric status out of the Worker without parsing the message. */
export class PtcScriptLoadError extends Error {
    status;
    constructor(status, message) {
        super(message);
        this.status = status;
        this.name = 'PtcScriptLoadError';
    }
}
/** Every refusal names the directories, so a program can report where to look. */
export function ptcScriptError(reason, roots) {
    return new PtcScriptLoadError('rejected', withDirectories(reason, roots));
}
/** Every directory `import()` may read, in the order the error message lists them. */
export function allowedDirectories(roots) {
    return [...(roots.project ? [roots.project] : []), roots.user, ...roots.skills];
}
export function withDirectories(reason, roots) {
    const directories = allowedDirectories(roots);
    return directories.length > 0
        ? `${reason} Allowed directories: ${directories.join(', ')}.`
        : reason;
}
//# sourceMappingURL=errors.js.map