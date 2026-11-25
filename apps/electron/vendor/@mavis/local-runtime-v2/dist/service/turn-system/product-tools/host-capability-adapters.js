import { describeLocalBrowserToolInput } from '@mavis/agent-tools/desktop';
import { HostCapabilityRegistry } from '@mavis/harness';
/**
 * The admitted native Browser is published as `mcp_browser`; its results keep
 * that name, and the program guide's run_code call names the tool the model sees.
 */
const exposeAsMcpBrowser = (binding) => ({
    ...binding.tool,
    def: {
        ...binding.tool.def,
        name: 'mcp_browser',
        description: binding.tool.def.description.replaceAll('tools.browser(', 'tools.mcp_browser('),
    },
    impl: {
        async execute(ctx, input, signal, onUpdate) {
            const result = await binding.tool.impl.execute(ctx, input, signal, onUpdate);
            return { ...result, tool_name: 'mcp_browser' };
        },
    },
});
/**
 * @internal Exported only for focused tests.
 * Browser-specific registration kept outside the generic Plugin/Binding pipeline.
 */
export function createBrowserHostCapabilityAdapter(describeInput) {
    return {
        capability: { id: 'browser.use', version: 1 },
        selectTarget: (tools) => tools.find((tool) => tool.def.name === 'browser'),
        describeInput,
        exposeTool: exposeAsMcpBrowser,
    };
}
/**
 * @internal Exported only for focused tests.
 * Keep the existing native tool names and schemas after official Binding admission.
 */
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
export function createHostCapabilityRegistry(cliProductPolicy) {
    return new HostCapabilityRegistry([
        // CLI keeps its native Browser path; only CU uses the shared interactive Binding.
        ...(cliProductPolicy
            ? []
            : [createBrowserHostCapabilityAdapter(describeLocalBrowserToolInput)]),
        createComputerUseHostCapabilityAdapter(),
    ], { reserveInlineGateway: !cliProductPolicy });
}
//# sourceMappingURL=host-capability-adapters.js.map