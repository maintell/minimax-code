/** Disclose admitted contracts as tool-result data, never as Skill file text or tools[] definitions. */
export function withHostSkillContracts(tools, references) {
    if (references.size === 0)
        return tools;
    return tools.map((tool) => tool.def.name !== 'skill'
        ? tool
        : {
            ...tool,
            impl: {
                async execute(ctx, input, signal, onUpdate) {
                    const result = await tool.impl.execute(ctx, input, signal, onUpdate);
                    const details = result.details;
                    const name = requestedSkillName(input);
                    if (result.isError ||
                        details?.kind !== 'skill' ||
                        details.source !== 'desktop-plugin' ||
                        details.found !== true ||
                        details.readable !== true ||
                        details.skill !== name) {
                        return result;
                    }
                    const contracts = [...references]
                        .filter(([, target]) => name !== undefined && target.requiredSkillRuntimeNames.includes(name))
                        .map(([toolRef, target]) => ({
                        tool_ref: toolRef,
                        arguments_schema: target.inputSchema,
                        arguments_transport: 'arguments_json',
                    }));
                    if (contracts.length === 0)
                        return result;
                    const text = `## Host tool contracts
Host-generated for this turn, separate from the Skill file. Call mcp_invoke with the exact tool_ref, omit arguments, and set arguments_json to a JSON-encoded object matching arguments_schema. Keep arrays, booleans, and numbers as their native JSON types inside that string. These schemas do not grant permission; runtime safety checks still apply.
${JSON.stringify(contracts)}`;
                    return {
                        ...result,
                        text: `${result.text}\n\n${text}`,
                        content: [...result.content, { type: 'text', text }],
                        details: { ...details, hostToolContracts: contracts },
                    };
                },
            },
        });
}
function requestedSkillName(input) {
    return input && typeof input === 'object' && 'name' in input && typeof input.name === 'string'
        ? input.name.trim()
        : undefined;
}
//# sourceMappingURL=skill-disclosure.js.map