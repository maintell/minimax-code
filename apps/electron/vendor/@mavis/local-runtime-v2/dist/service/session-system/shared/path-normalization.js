import path from 'node:path';
export function normalizeAbsolutePath(value) {
    const input = value?.trim();
    if (!input)
        return undefined;
    const flavor = pathFlavor(input);
    if (!flavor.isAbsolute(input))
        return undefined;
    return trimTrailingSeparators(flavor.normalize(input));
}
export function pathFlavor(value) {
    return /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith('\\\\') ? path.win32 : path.posix;
}
export function trimTrailingSeparators(value) {
    if (value === '/' || /^[A-Za-z]:\\$/u.test(value))
        return value;
    if (/^\\\\[^\\]+\\[^\\]+\\?$/u.test(value))
        return value.replace(/\\$/u, '');
    return value.replace(/[\\/]+$/u, '');
}
//# sourceMappingURL=path-normalization.js.map