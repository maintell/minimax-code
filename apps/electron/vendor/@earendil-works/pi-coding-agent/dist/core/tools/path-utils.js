import { accessSync, constants } from "node:fs";
import { access } from "node:fs/promises";
import { normalizePath, resolvePath } from "../../utils/paths.js";
const NARROW_NO_BREAK_SPACE = "\u202F";
function tryMacOSScreenshotPath(filePath) {
    return filePath.replace(/ (AM|PM)\./gi, `${NARROW_NO_BREAK_SPACE}$1.`);
}
function tryNFDVariant(filePath) {
    // macOS stores filenames in NFD (decomposed) form, try converting user input to NFD
    return filePath.normalize("NFD");
}
function tryCurlyQuoteVariant(filePath) {
    // macOS uses U+2019 (right single quotation mark) in screenshot names like "Capture d'écran"
    // Users typically type U+0027 (straight apostrophe)
    return filePath.replace(/'/g, "\u2019");
}
function fileExists(filePath) {
    try {
        accessSync(filePath, constants.F_OK);
        return true;
    }
    catch {
        return false;
    }
}
export async function pathExists(filePath) {
    try {
        await access(filePath, constants.F_OK);
        return true;
    }
    catch {
        return false;
    }
}
export function expandPath(filePath) {
    return normalizePath(filePath, { normalizeUnicodeSpaces: true, stripAtPrefix: true });
}
/**
 * Resolve a path relative to the given cwd.
 * Handles ~ expansion and absolute paths.
 */
export function resolveToCwd(filePath, cwd) {
    return resolvePath(filePath, cwd, { normalizeUnicodeSpaces: true, stripAtPrefix: true });
}
export function resolveReadPath(filePath, cwd) {
    const resolved = resolveToCwd(filePath, cwd);
    if (fileExists(resolved)) {
        return resolved;
    }
    // Try macOS AM/PM variant (narrow no-break space before AM/PM)
    const amPmVariant = tryMacOSScreenshotPath(resolved);
    if (amPmVariant !== resolved && fileExists(amPmVariant)) {
        return amPmVariant;
    }
    // Try NFD variant (macOS stores filenames in NFD form)
    const nfdVariant = tryNFDVariant(resolved);
    if (nfdVariant !== resolved && fileExists(nfdVariant)) {
        return nfdVariant;
    }
    // Try curly quote variant (macOS uses U+2019 in screenshot names)
    const curlyVariant = tryCurlyQuoteVariant(resolved);
    if (curlyVariant !== resolved && fileExists(curlyVariant)) {
        return curlyVariant;
    }
    // Try combined NFD + curly quote (for French macOS screenshots like "Capture d'écran")
    const nfdCurlyVariant = tryCurlyQuoteVariant(nfdVariant);
    if (nfdCurlyVariant !== resolved && fileExists(nfdCurlyVariant)) {
        return nfdCurlyVariant;
    }
    return resolved;
}
/** Hosts can keep path probes on the same filesystem as their read operations. */
export async function resolveReadPathAsync(filePath, cwd, probe = pathExists) {
    const resolved = resolveToCwd(filePath, cwd);
    if (await probe(resolved)) {
        return resolved;
    }
    // Try macOS AM/PM variant (narrow no-break space before AM/PM)
    const amPmVariant = tryMacOSScreenshotPath(resolved);
    if (amPmVariant !== resolved && (await probe(amPmVariant))) {
        return amPmVariant;
    }
    // Try NFD variant (macOS stores filenames in NFD form)
    const nfdVariant = tryNFDVariant(resolved);
    if (nfdVariant !== resolved && (await probe(nfdVariant))) {
        return nfdVariant;
    }
    // Try curly quote variant (macOS uses U+2019 in screenshot names)
    const curlyVariant = tryCurlyQuoteVariant(resolved);
    if (curlyVariant !== resolved && (await probe(curlyVariant))) {
        return curlyVariant;
    }
    // Try combined NFD + curly quote (for French macOS screenshots like "Capture d'écran")
    const nfdCurlyVariant = tryCurlyQuoteVariant(nfdVariant);
    if (nfdCurlyVariant !== resolved && (await probe(nfdCurlyVariant))) {
        return nfdCurlyVariant;
    }
    return resolved;
}
//# sourceMappingURL=path-utils.js.map