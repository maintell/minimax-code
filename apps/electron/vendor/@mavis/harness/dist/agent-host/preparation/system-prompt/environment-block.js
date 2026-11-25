/** Formats the `# Environment` layer: the Host's entries, then its rule paragraphs. */
export function environmentContextBlock(facts) {
    const rules = facts.rules.length > 0 ? ['', facts.rules.join('\n\n')] : [];
    return ['# Environment', ...facts.entries, ...rules].join('\n');
}
//# sourceMappingURL=environment-block.js.map