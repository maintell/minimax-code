import { parsePluginMentions } from '@mavis/shared/plugin-mention';
/**
 * Resolve canonical `@Plugin` references against the enabled capability
 * inventory for this turn. References must be whitespace-delimited so email
 * addresses, prefixes, and punctuation-attached plain text are not treated as
 * an explicit Plugin selection.
 */
export function detectPluginReferencesForMessages(messages, fallbackText, plugins) {
    if (!plugins || plugins.length === 0)
        return [];
    const texts = messages.length === 0
        ? [fallbackText]
        : messages.flatMap((message) => (message.content?.trim() ? [message.content] : []));
    const selected = [];
    const seen = new Set();
    for (const text of texts) {
        for (const match of detectReferencesInText(text, plugins)) {
            const key = match.pluginId ?? normalizedName(match.name);
            if (seen.has(key))
                continue;
            seen.add(key);
            selected.push(match);
        }
    }
    return selected;
}
/** Render one self-contained reminder for every Plugin selected in this turn. */
export function buildPluginReferenceReminder(plugins, unavailablePluginIds = []) {
    if (plugins.length === 0 && unavailablePluginIds.length === 0)
        return undefined;
    const blocks = plugins.slice(0, 8).map((plugin) => {
        const name = inlineCode(plugin.name);
        const detail = [
            `<selected-plugin name="${escapeXml(plugin.name)}">`,
            `Referenced as \`@${name}\`.`,
            '',
            ...(plugin.appCliProviders?.length
                ? [
                    '<app-cli-providers>',
                    ...[...new Set(plugin.appCliProviders)]
                        .sort()
                        .map((provider) => `- app \`${inlineCode(provider)}\` via mcode-tools`),
                    'These are Plugin declarations, not proof of a current connection.',
                    'After loading mcode-tools-master, discover tools for each listed App relevant to the request by running `mcode-tools connector tools --keyword "app_name"` through Bash. Replace app_name with the exact App identifier listed above, not the Plugin name or a translated display name. Use the App identifier alone to list all matching tool names and descriptions before selecting a tool.',
                    'The keyword matches tool names and descriptions, so verify that each selected tool belongs to the intended App. Inspect its schema with `mcode-tools connector tool <tool_name>` before calling it. An empty or partial result does not prove the App is disconnected; check provider_failures and, if needed, retry discovery without a keyword.',
                    '</app-cli-providers>',
                ]
                : [
                    '<connected-app-tools>',
                    formatAppToolGroups(plugin.appTools),
                    '</connected-app-tools>',
                ]),
            '',
            '<plugin-mcp-tools>',
            formatToolGroups(plugin.mcpTools, 'server'),
            '</plugin-mcp-tools>',
            '',
            ...(plugin.hostTools
                ? [
                    '<plugin-host-tools>',
                    formatToolGroups(plugin.hostTools, 'host'),
                    '</plugin-host-tools>',
                    '',
                ]
                : []),
            '<plugin-skills>',
            formatSkills(plugin.skills),
            '</plugin-skills>',
            '</selected-plugin>',
        ].join('\n');
        return detail.length <= 4096
            ? detail
            : `<selected-plugin name="${escapeXml(plugin.name).slice(0, 512)}">\nCapability details omitted to fit the context limit. Use this Plugin's tool provenance and Skill namespace in the available catalogs.\n</selected-plugin>`;
    });
    const bounded = [];
    let remaining = 12_288;
    let omitted = plugins.length > 8 || unavailablePluginIds.length > 8;
    for (const block of [
        ...blocks,
        ...unavailablePluginIds
            .slice(0, 8)
            .map((id) => `Selected Plugin \`${inlineCode(id)}\` is unavailable for this turn. Tell the user it could not be used; do not substitute a same-named Plugin or enable/install it automatically.`),
    ]) {
        if (block.length + 2 > remaining) {
            omitted = true;
            continue;
        }
        bounded.push(block);
        remaining -= block.length + 2;
    }
    return [
        '<system-reminder>',
        'The user explicitly selected the following Plugin capabilities for this request.',
        'Prefer them when relevant; other tools remain available if needed.',
        '',
        bounded.join('\n\n'),
        ...(omitted ? ['Additional selected capabilities omitted to fit the context limit.'] : []),
        '',
        'Use the listed Plugin capabilities through their stated access paths; current tool schemas govern direct calls. Lists may be truncated.',
        'Do not invent or claim unavailable Plugin capabilities.',
        ...(plugins.some((plugin) => plugin.appCliProviders?.length)
            ? [
                'For App access, load mcode-tools-master and use Bash when available. If Bash or the Skill is unavailable, report that this Agent cannot use App tools; do not assume a direct fallback. CLI results determine current availability and authorization.',
                'When the selected Plugin declares an App relevant to the request, discover that App before substituting general web search. Do not treat an empty direct App tool list as absence of App capabilities.',
            ]
            : []),
        ...(plugins.some((plugin) => [...plugin.appTools, ...plugin.mcpTools].some((group) => group.access === 'tool_search'))
            ? [
                'For tools marked `via tool_search + mcp_invoke`, discover the exact tool with `tool_search` before calling it through `mcp_invoke`.',
            ]
            : []),
        'Before following a listed Skill, call the `skill` tool with its exact name.',
        'The existing tool schemas and loaded SKILL.md content are authoritative.',
        '</system-reminder>',
    ].join('\n');
}
function formatAppToolGroups(groups) {
    if (groups.length === 0)
        return 'none';
    return [...groups]
        .slice(0, 16)
        .sort((left, right) => {
        const sourceOrder = normalizedName(left.source).localeCompare(normalizedName(right.source));
        if (sourceOrder !== 0)
            return sourceOrder;
        return (left.access ?? 'direct').localeCompare(right.access ?? 'direct');
    })
        .map((group) => {
        const tools = formatToolNames(group.tools);
        const access = group.access === 'tool_search' ? ' via `tool_search` + `mcp_invoke`' : '';
        return `- app \`${inlineCode(group.source)}\`${access}: ${tools || 'none'}`;
    })
        .join('\n');
}
function detectReferencesInText(text, plugins) {
    const linked = parsePluginMentions(text);
    let plainText = text;
    for (const mention of [...linked].reverse())
        plainText = `${plainText.slice(0, mention.start)}${' '.repeat(mention.end - mention.start)}${plainText.slice(mention.end)}`;
    const normalizedText = plainText.normalize('NFKC');
    const matches = [];
    for (const plugin of plugins) {
        const explicit = linked.find((mention) => mention.pluginId === plugin.pluginId);
        if (explicit) {
            matches.push({ index: explicit.start, plugin });
            continue;
        }
        const name = normalizedName(plugin.name);
        if (!name ||
            plugins.filter((candidate) => normalizedName(candidate.name) === name).length !== 1)
            continue;
        const pattern = new RegExp(`(^|\\s)@${escapeRegExp(name)}(?=\\s|$)`, 'giu');
        const match = pattern.exec(normalizedText);
        if (!match)
            continue;
        matches.push({ index: match.index + (match[1]?.length ?? 0), plugin });
    }
    matches.sort((left, right) => left.index - right.index);
    return matches.map((match) => match.plugin);
}
function formatToolGroups(groups, label) {
    if (groups.length === 0)
        return 'none';
    return [...groups]
        .slice(0, 16)
        .sort((left, right) => normalizedName(left.source).localeCompare(normalizedName(right.source)))
        .map((group) => {
        const tools = formatToolNames(group.tools);
        const access = group.access === 'tool_search' ? ' via `tool_search` + `mcp_invoke`' : '';
        return `- ${label} \`${inlineCode(group.source)}\`${access}: ${tools || 'none'}`;
    })
        .join('\n');
}
function formatToolNames(tools) {
    return [...new Set(tools)]
        .slice(0, 32)
        .sort((left, right) => normalizedName(left).localeCompare(normalizedName(right)))
        .map((tool) => `\`${inlineCode(tool)}\``)
        .join(', ');
}
function formatSkills(skills) {
    if (skills.length === 0)
        return 'none';
    return [...new Set(skills)]
        .slice(0, 32)
        .sort((left, right) => normalizedName(left).localeCompare(normalizedName(right)))
        .map((skill) => `- \`${inlineCode(skill)}\``)
        .join('\n');
}
function normalizedName(value) {
    return value.trim().normalize('NFKC').toLocaleLowerCase('en-US');
}
function inlineCode(value) {
    return escapeXml(value).replace(/`/gu, '\\`');
}
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
function escapeXml(value) {
    return value
        .replace(/&/gu, '&amp;')
        .replace(/</gu, '&lt;')
        .replace(/>/gu, '&gt;')
        .replace(/"/gu, '&quot;')
        .replace(/'/gu, '&apos;');
}
//# sourceMappingURL=plugin-reference.js.map