import { SCHEMA_SNAPSHOT_STATEMENTS } from './safe-mode-snapshot.js';
export function ensureSchemaSnapshot(db, statements = SCHEMA_SNAPSHOT_STATEMENTS) {
    const errors = [];
    for (const [statementIndex, statement] of statements.entries()) {
        try {
            db.exec(statement);
        }
        catch (error) {
            errors.push({
                statementIndex,
                statementHead: statement.slice(0, 120),
                message: error instanceof Error ? error.message : String(error),
            });
        }
    }
    return { attemptedStatements: statements.length, errors };
}
//# sourceMappingURL=safe-mode-snapshot-ensure.js.map