import { CRON_TOOL_NAMES, agentNameDescription, } from '@mavis/agent-tools/desktop';
import { AGENT_BUILTIN_TOOL_IDS, isAgentBuiltinToolEnabled, } from '@mavis/config';
export function filterLocalBuiltinCapabilityTools(tools, capabilities) {
    const configurableToolNames = new Set(AGENT_BUILTIN_TOOL_IDS);
    const capabilityFiltered = tools.filter((tool) => (!['mavis', ...CRON_TOOL_NAMES].includes(tool.def.name) || capabilities.features.mavis) &&
        (!configurableToolNames.has(tool.def.name) ||
            isAgentBuiltinToolEnabled(capabilities, tool.def.name)));
    return capabilities.features.mavis
        ? capabilityFiltered
        : capabilityFiltered.map(withoutMavisTaskAgentNameDescription);
}
function withoutMavisTaskAgentNameDescription(tool) {
    if (tool.def.name !== 'task')
        return tool;
    const schema = tool.def.schema;
    const agentName = schema.properties?.agent_name;
    if (!agentName)
        return tool;
    return {
        ...tool,
        def: {
            ...tool.def,
            schema: {
                ...tool.def.schema,
                properties: {
                    ...schema.properties,
                    agent_name: {
                        ...agentName,
                        description: agentNameDescription({ includeMavis: false }),
                    },
                },
            },
        },
    };
}
//# sourceMappingURL=local-native-tool-filter.js.map