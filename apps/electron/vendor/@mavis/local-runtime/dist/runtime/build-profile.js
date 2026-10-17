export function getBundleBuildProfile() {
    return typeof __BUILD_PROFILE__ === 'string' ? __BUILD_PROFILE__ : 'default';
}
export function isVelaBuild(buildProfile = getBundleBuildProfile()) {
    return buildProfile === 'vela';
}
//# sourceMappingURL=build-profile.js.map