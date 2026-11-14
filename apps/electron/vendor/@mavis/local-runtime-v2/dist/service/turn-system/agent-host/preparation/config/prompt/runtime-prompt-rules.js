import { FILE_OPERATION_RULES, LANGUAGE_RULES, SYSTEM_REMINDER_DESCRIPTION, TOOL_CALL_PREAMBLE_REMINDER, } from '../../prompt-blocks.js';
export function miniAppSuggestionOverrides(capability, session, profile, overrides) {
    if (!capability.available ||
        capability.preference?.enabled === false ||
        Boolean(session.purpose) ||
        session.visibility === 'hidden' ||
        !(profile ? profile.surface === 'interactive' : (session.sessionType ?? 'root') === 'root'))
        return overrides;
    return {
        ...overrides,
        appendSystemPrompt: [overrides?.appendSystemPrompt, MINIAPP_SUGGESTION_GUIDANCE]
            .filter(Boolean)
            .join('\n\n'),
    };
}
/** Optional metadata for ordinary local Desktop conversations. */
const MINIAPP_SUGGESTION_GUIDANCE = `
# Optional Mini App recommendation metadata
After completing the ordinary response to the user, check the existing conversation against ALL of these conditions:
1. The user explicitly accepted the current result/version (not merely asked you to produce it).
2. There is explicit intent to reuse this method with different inputs, or visible repeated use of the same workflow in this conversation. A generic approval alone is not reuse evidence; never claim cross-conversation frequency you cannot see.
3. A concrete accepted artifact or method exists, with known fixed rules and variable inputs.
4. An independent input/result interface provides useful value beyond an existing Skill, script, spreadsheet or cron.
If the user explicitly asks to create or modify a Mini App, follow that request with the existing creation or maintenance workflow; do not replace it with a recommendation or require another click.
Never suggest during corrections, unresolved errors, one-off tasks, explicit preference for another platform, or inside a Mini App creation/maintenance task. Do not invent user approval, evidence, files or dependencies. Do not suggest merely because a task could be automated. If any condition is missing, answer normally without a card or a sales pitch.
When ALL conditions hold, you may append optional Mini App suggestion metadata after your complete ordinary answer. The answer must remain complete and useful if the metadata is removed: some clients, including remote-control clients, do not display a suggestion card. Never end the turn early, omit requested work, replace the ordinary answer with a short acknowledgment, or depend on the user clicking a card. This optional metadata does not override the user's request or general instructions to complete their work. Do not inspect the environment, run tools, read credentials, install dependencies, probe model APIs, invoke miniapp-creator, or begin building merely to produce a recommendation; the accepted result supplies the brief. Explicit requests to create or modify an app still follow the ordinary workflow.
Emit exactly one self-closing tag outside code fences:
<genui-miniapp-suggestion title="short app name" reason="specific benefit for next use" accepted="accepted artifact/version and approval evidence" rules="fixed rules to preserve" inputs="inputs that change every run" outputs="real result format" />
Fill every attribute from this conversation, in the user's language. Escape XML attribute quotes as &quot; and angle brackets as &lt; and &gt;. Keep total attributes below 6000 characters. Do not put full chat history or credentials in the tag. Per-run numbers, scores, content, names and dates belong in inputs, never fixed rules. A supporting desktop client may show a dismissible banner to review/edit this brief and explicitly start the existing creator; emitting a tag does not authorize creation or installation. Do not assume a banner is visible, tell the user to click it, or add a sales pitch to the ordinary answer. If a suggestion tag already exists in this conversation, do not emit another unless the user explicitly asks to revisit it. If the user declines, do not suggest again.
`;
export function addRuntimeRules(prompt, interactiveSurface, rootSessionPrompt = '') {
    const harnessRules = [`- ${SYSTEM_REMINDER_DESCRIPTION}`, FILE_OPERATION_RULES];
    if (process.platform === 'win32') {
        harnessRules.push('- Install system software with winget, scoop, choco, or similar only with explicit user approval.', '- Preserve the existing CRLF or LF line endings when editing files.');
    }
    let result = addSectionGuidance(prompt, '# Harness', harnessRules.join('\n'));
    result = addSectionGuidance(result, '## Response Style', LANGUAGE_RULES, '# Communication & Delivery');
    if (interactiveSurface) {
        if (rootSessionPrompt.trim()) {
            result = addSectionGuidance(result, '# Core Judgment', rootSessionPrompt.trim());
        }
        result = addSectionGuidance(result, '## Preamble messages', TOOL_CALL_PREAMBLE_REMINDER, '# Communication & Delivery');
    }
    return result;
}
/** Insert before range projection; headings inside fenced examples are data. */
function addSectionGuidance(prompt, heading, guidance, fallbackHeading = heading) {
    const lines = prompt.split('\n');
    const headings = findPromptHeadings(lines);
    const targetHeading = headings.has(headingTitle(heading)) ? heading : fallbackHeading;
    const target = headings.get(headingTitle(targetHeading));
    if (target === undefined) {
        return [prompt.trim(), `${fallbackHeading}\n${guidance}`].filter(Boolean).join('\n\n');
    }
    // Apollo and custom prompts may retain older levels; follow their existing hierarchy.
    const levelOffset = target.level - targetHeading.indexOf(' ');
    const guidanceLines = alignGuidanceHeadings(guidance, levelOffset);
    const insertionIndex = target.index + 1;
    let contentIndex = insertionIndex;
    while (contentIndex < lines.length && !lines[contentIndex]?.trim())
        contentIndex += 1;
    const continuesList = /^[-*+] /u.test(guidanceLines.at(-1) ?? '') && /^[-*+] /u.test(lines[contentIndex] ?? '');
    lines.splice(insertionIndex, contentIndex - insertionIndex, ...guidanceLines, ...(contentIndex < lines.length && !continuesList ? [''] : []));
    return lines.join('\n');
}
function alignGuidanceHeadings(guidance, levelOffset) {
    const lines = guidance.split('\n');
    for (const { index, level } of findPromptHeadings(lines).values()) {
        lines[index] =
            `${'#'.repeat(Math.min(6, Math.max(1, level + levelOffset)))} ${headingTitle(lines[index] ?? '')}`;
    }
    return lines;
}
function headingTitle(heading) {
    return heading.replace(/^#{1,6} /u, '').trim();
}
function findPromptHeadings(lines) {
    const headings = new Map();
    let fence = '';
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? '';
        const marker = /^ {0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
        if (marker) {
            if (!fence)
                fence = marker;
            else if (marker[0] === fence[0] && marker.length >= fence.length)
                fence = '';
            continue;
        }
        const heading = !fence && /^(#{1,6}) /u.exec(line);
        if (heading && !headings.has(headingTitle(line))) {
            headings.set(headingTitle(line), { index, level: heading[1].length });
        }
    }
    return headings;
}
export function runtimeFeatureScope(session, runtimeFacts, profile, hostFeatures) {
    const interactive = profile?.surface === 'interactive';
    return {
        ...(runtimeFacts.exposeComputerUseActive
            ? { computerUseActive: runtimeFacts.computerUseActive }
            : {}),
        ...(hostFeatures.pptPreviewAvailable && interactive ? { pptPreviewAvailable: true } : {}),
        ...(hostFeatures.miniappAvailable && interactive ? { miniappAvailable: true } : {}),
        ...(hostFeatures.pluginRecommendationAvailable && interactive && exposesPluginDiscovery(session)
            ? { pluginRecommendationAvailable: true }
            : {}),
        ...(profile?.surface ? { surface: profile.surface } : {}),
    };
}
/** Plugin discovery runs in user conversations only, never in a Mini App's own Agent session. */
function exposesPluginDiscovery(session) {
    return session.sessionKind === 'conversation' && !session.miniAppOrigin;
}
//# sourceMappingURL=runtime-prompt-rules.js.map