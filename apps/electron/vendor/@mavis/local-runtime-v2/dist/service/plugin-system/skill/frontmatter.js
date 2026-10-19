import { parseDocument } from 'yaml';
import { readerFail } from '../plugin/package/reader-errors.js';
export function parseSkillFrontmatter(content, relativeSkillFile) {
    const opening = /^---\r?\n/u.exec(content);
    if (!opening) {
        readerFail('SKILL_SCHEMA_INVALID', `${relativeSkillFile} must start with YAML frontmatter`);
    }
    const remainder = content.slice(opening[0].length);
    const closing = /(?:^|\r?\n)---(?:\r?\n|$)/u.exec(remainder);
    if (!closing || closing.index === undefined) {
        readerFail('SKILL_SCHEMA_INVALID', `${relativeSkillFile} has unclosed YAML frontmatter`);
    }
    const yamlText = remainder.slice(0, closing.index + delimiterPrefixLength(closing[0]));
    const value = parseFrontmatterYaml(yamlText, relativeSkillFile);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        readerFail('SKILL_SCHEMA_INVALID', `${relativeSkillFile} frontmatter must be a mapping`);
    }
    return value;
}
function delimiterPrefixLength(delimiter) {
    if (delimiter.startsWith('\r\n'))
        return 2;
    if (delimiter.startsWith('\n'))
        return 1;
    return 0;
}
function parseFrontmatterYaml(yamlText, relativeSkillFile) {
    let document;
    try {
        document = parseDocument(yamlText, { uniqueKeys: true });
    }
    catch {
        readerFail('SKILL_SCHEMA_INVALID', `${relativeSkillFile} has invalid YAML frontmatter`);
    }
    if (document.errors.length > 0) {
        readerFail('SKILL_SCHEMA_INVALID', `${relativeSkillFile} has invalid YAML frontmatter`);
    }
    let value;
    try {
        value = document.toJS({ maxAliasCount: 20 });
    }
    catch {
        readerFail('SKILL_SCHEMA_INVALID', `${relativeSkillFile} has invalid YAML frontmatter`);
    }
    return value;
}
//# sourceMappingURL=frontmatter.js.map