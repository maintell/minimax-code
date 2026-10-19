const SCREENSHOT_TOOLS = new Set(['computer_app_state', 'computer_desktop_state']);
/** Keeps only the newest inline CU screenshots in each LLM context. */
export function createLocalCuScreenshotPruner(maxScreenshots) {
    return async (input) => {
        if (maxScreenshots <= 0)
            return undefined;
        const locations = input.messages.reduceRight((found, message, messageIndex) => {
            const record = isRecord(message) ? message : {};
            const name = record.tool_name ?? record.name ?? record.toolName;
            if ((record.role !== 'tool' && record.role !== 'toolResult') ||
                typeof name !== 'string' ||
                !SCREENSHOT_TOOLS.has(name)) {
                return found;
            }
            const content = Array.isArray(record.content) ? record.content : [];
            content.reduceRight((_, part, contentIndex) => {
                if (Reflect.get(Object(part), 'type') === 'image') {
                    found.push({ message: messageIndex, content: contentIndex });
                }
                return undefined;
            }, undefined);
            return found;
        }, []);
        const toPrune = locations.slice(maxScreenshots);
        if (toPrune.length === 0)
            return undefined;
        const pruned = structuredClone(input.messages);
        toPrune.forEach(({ message, content }) => {
            const record = pruned[message];
            if (!isRecord(record) || !Array.isArray(record.content))
                return;
            const parts = record.content;
            parts[content] = {
                type: 'text',
                text: '[CU screenshot pruned from context. Take a new screenshot if current visual state is needed.]',
            };
        });
        return {
            type: 'replaceRequestMessages',
            messages: pruned,
            reason: `Pruned ${toPrune.length} old CU screenshot(s) from the provider request only.`,
        };
    };
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
//# sourceMappingURL=local-cu-screenshot-pruner.js.map