import path from 'node:path';
export function fallbackSkillName(relativeSkillFile) {
    return path.posix.basename(path.posix.dirname(relativeSkillFile.replaceAll('\\', '/')));
}
export function readSkillStringField(record, key) {
    const value = record[key];
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
//# sourceMappingURL=identity.js.map