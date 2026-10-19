const SWIM_LANE_ARGUMENT_PREFIX = '--swim-lane=';
export function resolveDevelopmentSwimLaneOverride(argv, development) {
    if (!development)
        return undefined;
    for (let index = argv.length - 1; index >= 0; index -= 1) {
        const argument = argv[index];
        if (argument?.startsWith(SWIM_LANE_ARGUMENT_PREFIX)) {
            return argument.slice(SWIM_LANE_ARGUMENT_PREFIX.length).trim();
        }
    }
    return undefined;
}
