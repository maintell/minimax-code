/** Keep the existing native tool names and schemas after official Binding admission. */
export function createComputerUseHostCapabilityAdapter() {
    return {
        capability: { id: 'computer.use', version: 1 },
        // CU tools exist only after preflight admission and computerUseActive. An admitted TUI
        // uses the existing interactive Binding without changing its Agent profile or other adapters.
        resolveBindingSurface: (surface) => (surface === 'cli' ? 'interactive' : surface),
        selectTargets: (tools) => tools.filter((tool) => tool.def.name.startsWith('computer_')),
        exposeTool: ({ tool }) => tool,
    };
}
//# sourceMappingURL=computer.js.map