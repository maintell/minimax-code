/**
 * `skill` 工具结果的模型可见形状。v1 CloudSkillTool 与 v2 cloud-harness-server 的 skill 工具共用，
 * 保证两边工具结果文本逐字一致。
 */
import { formatSkillContent } from './skill-reader.js';
/** 工具入参里的 skill 名；缺省或空白时为 `unknown-skill`。 */
export function skillReadName(input) {
    return (typeof input.name === 'string' && input.name.trim()) || 'unknown-skill';
}
export function skillNotFound(name) {
    return {
        text: `Cloud Host skill not found: ${name}`,
        skill: name,
        found: false,
        readable: false,
        source: 'none',
    };
}
export function skillFound(name, content, location, source) {
    return {
        text: formatSkillContent(name, content, location),
        skill: name,
        found: true,
        readable: true,
        source,
    };
}
export function skillReadToolResult(outcome) {
    return {
        tool_name: 'skill',
        text: outcome.text,
        content: [{ type: 'text', text: outcome.text }],
        details: {
            kind: 'skill',
            skill: outcome.skill,
            found: outcome.found,
            readable: outcome.readable,
            source: outcome.source,
            owner: 'cloud_host',
        },
    };
}
//# sourceMappingURL=skill-read-result.js.map