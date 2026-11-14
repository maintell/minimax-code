const TOOL_SEARCH_TURN_FACTS = Symbol('mavis.tool-search.turn-facts');
/** Returns the same tool with the facts attached; decorators that spread the tool keep them. */
export function attachToolSearchTurnFacts(tool, facts) {
    Object.defineProperty(tool, TOOL_SEARCH_TURN_FACTS, { value: facts, enumerable: true });
    return tool;
}
export function readToolSearchTurnFacts(tools) {
    const search = tools?.find((tool) => tool.def.name === 'tool_search');
    return search ? search[TOOL_SEARCH_TURN_FACTS] : undefined;
}
//# sourceMappingURL=turn-facts.js.map