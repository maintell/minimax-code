/** Build-time product profile used by conversation prompt preparation. */
export function getLocalConversationBuildProfile() {
    return typeof __BUILD_PROFILE__ === 'string' ? __BUILD_PROFILE__ : 'default';
}
export function isLocalVelaBuild(buildProfile = getLocalConversationBuildProfile()) {
    return buildProfile === 'vela';
}
//# sourceMappingURL=build-profile.js.map