import {} from '@mavis/harness';
const isComputerUse = (tool) => tool.def.name.startsWith('computer_');
/**
 * An Agent selector may name the native Browser by its public `mcp_browser`
 * name only on an interactive Turn whose Browser Plugin Binding allows that
 * surface; the harness asks only when the Host registry is present.
 */
const browserSelectorAlias = (tool, { surface, desktopCapabilities }) => tool.def.name === 'browser' &&
    surface === 'interactive' &&
    desktopCapabilities?.hostBindings?.some((binding) => binding.hostCapability.id === 'browser.use' &&
        binding.hostCapability.version === 1 &&
        binding.allowedSurfaces.includes('interactive'))
    ? 'mcp_browser'
    : undefined;
/**
 * Computer Use calling convention, only when this run_code lists computer_*.
 * They act on one shared desktop, so they run one at a time (no
 * executionMode, the scheduler serializes them) and the host refuses a
 * program's remaining Computer Use calls after one fails
 * (COMPUTER_USE_PTC_STOPPED). AX state with query is the cheap read; a
 * screenshot is attached to the outer result after the program, so it is
 * asked for only when the step needs to see the window. Taking the
 * foreground is announced to the user before the program, because nothing
 * inside a program reaches the user. An irreversible action ends its program
 * so the next decision is made on its verified effect.
 */
function computerUseRunCodeParagraph(childTools) {
    if (!childTools.some(isComputerUse))
        return [];
    return [
        'Computer Use: await computer_* calls one by one, never in Promise.all; they act on one shared desktop. Put one bounded step in one program: find the window, read its state, act, then read it back to verify. After one Computer Use call fails, the remaining Computer Use calls of that program are refused with COMPUTER_USE_PTC_STOPPED; check r.isError after each call and return early. Read AX state, narrowed with query, by default; pass include_screenshot: true only when you need to see the window, and the screenshot reaches you after the program. When a step must bring an app to the foreground, tell the user before running the program. An irreversible action (send, submit, delete, pay) is the last Computer Use call of its program; verify it in the next program. Example: const s = await tools.computer_app_state({ pid, window_ref, query: "Search" }); if (s.isError) return s.error; return s.output;',
    ];
}
/**
 * Desktop product rules every local Turn's raw tool sources carry. Browser
 * declares `observe` in its own definition and loads on demand, so it needs
 * no run_code variant or paragraph.
 */
export const DESKTOP_TOOL_CATALOG_RULES = {
    selectorAlias: browserSelectorAlias,
    requiresComputerUseRuntime: isComputerUse,
    runCodeParagraphs: computerUseRunCodeParagraph,
};
/**
 * Repeated per active turn so task continuation does not depend on historical tool lists.
 * A PTC Turn lists computer_* only inside run_code, so the hint also follows
 * run_code's children there and names the run_code call form; a Turn that
 * lists computer_* at top level keeps the original wording byte for byte.
 */
export const desktopPromptBlocks = ({ tools, childTools }) => {
    const topLevel = tools.some(isComputerUse);
    if (!topLevel && !childTools.some(isComputerUse))
        return [];
    return [
        [
            '<system-reminder>',
            topLevel
                ? 'Computer Use is enabled for this task. Use only the current computer_* tool schemas.'
                : 'Computer Use is enabled for this task. Call computer_* tools inside run_code with await tools.computer_<action>(args); use only the current computer_* tool schemas.',
            ...(tools.some((tool) => tool.def.name === 'skill')
                ? [
                    'Before desktop operations, load the computer-use:computer-use plugin skill with the skill tool.',
                ]
                : []),
            'Inspect the actual application and window before acting; do not guess app identifiers or shortcuts.',
            'Verify the resulting UI before claiming success. Report actual tool failures without inventing tool aliases.',
            '</system-reminder>',
        ].join('\n'),
    ];
};
//# sourceMappingURL=desktop-catalog-rules.js.map