/** Keep the existing native tool names and schemas after official Binding admission. */
export function createComputerUseHostCapabilityAdapter() {
    return {
        capability: { id: 'computer.use', version: 1 },
        selectTargets: (tools) => tools.filter((tool) => tool.def.name.startsWith('computer_')),
        exposeTool: ({ tool }) => tool,
    };
}
//# sourceMappingURL=computer.js.map