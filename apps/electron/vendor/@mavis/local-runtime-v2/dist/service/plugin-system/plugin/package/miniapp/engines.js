const REQUIREMENT = /^>=\s*(\d+)\.(\d+)\.(\d+)$/u;
const HOST_CORE = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u;
/** Only `>=MAJOR.MINOR.PATCH` is supported; anything else is a manifest error. */
export function parseMcodeEngineRequirement(requirement) {
    return core(REQUIREMENT.exec(requirement.trim()));
}
/** Pre-release and build suffixes are ignored: `3.2.0-beta.1` counts as `3.2.0`. */
function parseHostVersionCore(hostVersion) {
    return core(HOST_CORE.exec(hostVersion.trim()));
}
/**
 * The product rule in one place: a Host withholds a Mini App only when it is a parsable release
 * older than the package's `engines.mcode`. No requirement, no Host version, or a version the Host
 * cannot parse (a dev build without one) never gates.
 */
export function hostWithholdsMiniApp(hostVersion, requirement) {
    if (!requirement || !hostVersion || !parseHostVersionCore(hostVersion))
        return false;
    return !satisfiesMcodeEngine(hostVersion, requirement);
}
function satisfiesMcodeEngine(hostVersion, requirement) {
    const required = parseMcodeEngineRequirement(requirement);
    const host = parseHostVersionCore(hostVersion);
    if (!required || !host)
        return false;
    const [hostMajor, hostMinor, hostPatch] = host;
    const [major, minor, patch] = required;
    if (hostMajor !== major)
        return hostMajor > major;
    if (hostMinor !== minor)
        return hostMinor > minor;
    return hostPatch >= patch;
}
function core(match) {
    if (!match)
        return undefined;
    return [Number(match[1]), Number(match[2]), Number(match[3])];
}
//# sourceMappingURL=engines.js.map