/**
 * `/xxx` slash skill invocation detection for local-runtime turns.
 *
 * Mirrors cloud-runtime `session/slash-skill-reference.ts` detection: when a
 * user message starts with `/<skill-name>` and that name exists in the
 * agent's skill catalog, inject a short system-reminder telling the model to
 * load the full SKILL.md via the `skill` tool instead of treating the text
 * as a plain slash command.
 */
/**
 * Match a standalone or one-level `plugin:skill` identifier at the very start
 * of a user message.
 *
 * The trailing `(?:\s|$)` rejects absolute paths and multi-segment strings:
 * `/path/to/file` fails because the next character after `path` is `/`, not
 * whitespace or end-of-string. The first character must be alphanumeric so
 * junk slash prefixes (`/!!!`, `/?`, `/-foo`, `/_foo`) are ignored cheaply.
 */
const SLASH_SKILL_RE = /^\/([A-Za-z0-9][A-Za-z0-9._-]*(?::[A-Za-z0-9][A-Za-z0-9._-]*)?)(?:\s|$)/;
export function detectSlashSkillReference(userText, skills) {
    if (!skills || skills.length === 0)
        return null;
    const match = SLASH_SKILL_RE.exec(userText.trimStart());
    if (!match?.[1])
        return null;
    const requestedSkill = match[1].toLowerCase();
    return skills.find((s) => s.name.toLowerCase() === requestedSkill) ?? null;
}
export function buildSlashSkillReferenceReminder(skill) {
    return [
        '<system-reminder>',
        `The user explicitly requested the \`${skill.name}\` skill. Load its content directly via the \`skill\` tool with \`name: "${skill.name}"\`, and follow it.`,
        '</system-reminder>',
    ].join('\n');
}
/**
 * Scan raw user messages first: queued-batch and quoted-reply prompt
 * rendering prepends context before each message body, so the rendered
 * prompt text no longer starts with the `/<skill>` the user actually
 * typed. Falls back to the rendered prompt when no raw messages exist.
 */
export function buildSlashSkillReferenceReminderForMessages(messages, fallbackText, skills) {
    if (messages.length === 0) {
        const skill = detectSlashSkillReference(fallbackText, skills);
        return skill ? buildSlashSkillReferenceReminder(skill) : undefined;
    }
    for (const message of messages) {
        const content = message.content?.trim();
        if (!content)
            continue;
        const skill = detectSlashSkillReference(content, skills);
        if (skill)
            return buildSlashSkillReferenceReminder(skill);
    }
    return undefined;
}
//# sourceMappingURL=slash-skill-reference.js.map