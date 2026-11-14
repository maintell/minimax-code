const SECRET_PATTERNS = [
    /\b(?:sk|ak)-[A-Za-z0-9_-]{16,}\b/gu,
    /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/giu,
    /\b((?:api[_-]?key|access[_-]?token|password)\s*[:=]\s*)[^\s,;]+/giu,
];
/** 命中任一规则后写入的占位标记；截断逻辑按它对齐，避免切出半个标记。 */
export const REDACTION_MARK = '[REDACTED]';
export function redactMemorySecrets(content) {
    let hitCount = 0;
    let redacted = content;
    for (const pattern of SECRET_PATTERNS) {
        redacted = redacted.replace(pattern, (...args) => {
            hitCount += 1;
            const prefix = typeof args[1] === 'string' ? args[1] : '';
            return `${prefix}${REDACTION_MARK}`;
        });
    }
    return { content: redacted, hitCount };
}
//# sourceMappingURL=secret-redactor.js.map