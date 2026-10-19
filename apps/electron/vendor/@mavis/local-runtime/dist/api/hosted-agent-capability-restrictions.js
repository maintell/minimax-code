export function applyHostedCapabilityRestrictions(capabilities, restrictions) {
    if (!restrictions.disableMavis)
        return capabilities;
    return {
        ...capabilities,
        features: {
            ...capabilities.features,
            mavis: false,
        },
    };
}
//# sourceMappingURL=hosted-agent-capability-restrictions.js.map