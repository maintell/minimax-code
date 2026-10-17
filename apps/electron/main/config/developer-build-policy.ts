/** Shared fail-closed gate for Developer Options and preload companion bridges. */
export function isDeveloperBuildEligible(input) {
    return (!input.isInsideBuild &&
        (input.isDev || input.isTest || input.isStaging || input.isInternalBuild));
}
