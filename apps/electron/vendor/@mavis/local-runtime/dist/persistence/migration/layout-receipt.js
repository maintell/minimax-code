import fs from 'node:fs';
import path from 'node:path';
import { resolveV2DirectoryContract } from '../layout/v2-paths.js';
/**
 * Layout migration receipt: records the file identities of both legacy sqlite
 * sources and the v2 target after a cleanly completed copy/reconcile pass.
 * While all three identities still match, the sqlite copy/reconcile block is
 * skipped — the standing INSERT OR IGNORE reconcile must not resurrect rows
 * the user has since deleted from v2. The receipt only fingerprints the
 * sqlite files; ledgers/snapshots directories are outside its coverage and
 * are therefore never gated by it (they are re-copied on every run).
 *
 * The legacy sources are frozen after a completed pass, so their identity is
 * sampled aggressively: (dev, ino, birthtimeMs, sizeBytes, mtimeMs) plus the
 * existence/size/mtime of the sibling `-wal` file. A downgraded v1-era build
 * writes into those databases in place (same inode and birthtime), and a
 * downgrade crash can leave committed rows only in the WAL — both must
 * invalidate the receipt. WAL size alone is not enough: checkpoint cycles
 * rewrite WAL frames in place at an identical length, so the sample also
 * carries mtime. The v2 target keeps the plain (dev, ino, birthtimeMs)
 * triple: it is written on every normal run, so size/mtime there would void
 * the receipt permanently. Any mismatch, corruption, or missing/outdated
 * receipt falls back to the full migration pass. See
 * `.harness/docs/adr/local-runtime-migration-fault-tolerance.md`.
 */
export const LAYOUT_MIGRATION_RECEIPT_FILE = 'layout-receipt.json';
export const LAYOUT_RECEIPT_CURRENT_SKIP = 'layout:receipt-current';
export const LAYOUT_RECEIPT_WRITE_FAILED_NOTE = 'layout:receipt-write-failed';
const LAYOUT_RECEIPT_SCHEMA_VERSION = 3;
export function resolveLayoutMigrationReceiptPath(dataDir) {
    return path.join(resolveV2DirectoryContract(dataDir).migration, LAYOUT_MIGRATION_RECEIPT_FILE);
}
function captureLayoutMigrationIdentities(dataDir) {
    const v2 = resolveV2DirectoryContract(dataDir);
    return {
        sources: {
            legacyDraftDb: readSourceIdentityOrMissing(v2.legacyDraftDb),
            legacyCurrentDb: readSourceIdentityOrMissing(path.join(dataDir, 'local-runtime', 'local-runtime.sqlite')),
        },
        target: readFileIdentityOrMissing(v2.db),
    };
}
function readFileIdentityOrMissing(filePath) {
    try {
        const stats = fs.statSync(filePath);
        if (!stats.isFile())
            return 'missing';
        return { dev: stats.dev, ino: stats.ino, birthtimeMs: Math.floor(stats.birthtimeMs) };
    }
    catch {
        return 'missing';
    }
}
function readSourceIdentityOrMissing(filePath) {
    try {
        const stats = fs.statSync(filePath);
        if (!stats.isFile())
            return 'missing';
        return {
            dev: stats.dev,
            ino: stats.ino,
            birthtimeMs: Math.floor(stats.birthtimeMs),
            sizeBytes: stats.size,
            mtimeMs: Math.floor(stats.mtimeMs),
            wal: readWalSampleOrMissing(`${filePath}-wal`),
        };
    }
    catch {
        return 'missing';
    }
}
function readWalSampleOrMissing(walPath) {
    try {
        const stats = fs.statSync(walPath);
        if (!stats.isFile())
            return 'missing';
        return { sizeBytes: stats.size, mtimeMs: Math.floor(stats.mtimeMs) };
    }
    catch {
        return 'missing';
    }
}
/**
 * True only when a valid receipt exists and every recorded identity (both
 * legacy sources and the v2 target, including 'missing' markers) matches the
 * current filesystem state. Never throws: any read/parse failure means "not
 * current" and the caller runs the full copy/reconcile pass.
 */
export function isLayoutMigrationReceiptCurrent(dataDir) {
    const receipt = readLayoutMigrationReceipt(dataDir);
    if (!receipt)
        return false;
    const current = captureLayoutMigrationIdentities(dataDir);
    return (isSameSourceIdentity(receipt.sources.legacyDraftDb, current.sources.legacyDraftDb) &&
        isSameSourceIdentity(receipt.sources.legacyCurrentDb, current.sources.legacyCurrentDb) &&
        isSameFileIdentity(receipt.target, current.target));
}
export function readLayoutMigrationReceipt(dataDir) {
    try {
        const receiptPath = resolveLayoutMigrationReceiptPath(dataDir);
        const stats = fs.lstatSync(receiptPath);
        if (stats.isSymbolicLink() || !stats.isFile())
            return undefined;
        const parsed = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
        return isLayoutMigrationReceipt(parsed) ? parsed : undefined;
    }
    catch {
        return undefined;
    }
}
/**
 * Records the current three-way identities. Only called after a cleanly
 * completed migration pass; throws on write failure so the caller can decide
 * that the failure is non-fatal (the migration result itself stands).
 */
export function writeLayoutMigrationReceipt(dataDir, completedAtMs) {
    const contract = resolveV2DirectoryContract(dataDir);
    ensureManagedDirectory(contract.root);
    ensureManagedDirectory(contract.migration);
    const receiptPath = resolveLayoutMigrationReceiptPath(dataDir);
    ensureWriteTargetSafe(receiptPath);
    const identities = captureLayoutMigrationIdentities(dataDir);
    const receipt = {
        schemaVersion: LAYOUT_RECEIPT_SCHEMA_VERSION,
        completedAtMs,
        sources: identities.sources,
        target: identities.target,
    };
    fs.writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`, 'utf8');
    return receipt;
}
/**
 * Receipts from retired schema versions are treated as missing: the next
 * start runs one full copy/reconcile pass and rewrites the receipt in the
 * current schema. v1 lacked size/mtime/WAL sampling on the legacy sources;
 * v2 sampled the WAL by size only, which missed same-length in-place WAL
 * rewrites. Field-level validation below is the second safety net: a receipt
 * carrying the current schemaVersion but missing a sampled field is also
 * treated as missing (never a hit, never a throw).
 */
function isLayoutMigrationReceipt(value) {
    if (!value || typeof value !== 'object')
        return false;
    const receipt = value;
    if (receipt.schemaVersion !== LAYOUT_RECEIPT_SCHEMA_VERSION)
        return false;
    if (typeof receipt.completedAtMs !== 'number' || !Number.isSafeInteger(receipt.completedAtMs)) {
        return false;
    }
    const sources = receipt.sources;
    if (!sources || typeof sources !== 'object')
        return false;
    return (isLayoutReceiptSourceIdentity(sources.legacyDraftDb) &&
        isLayoutReceiptSourceIdentity(sources.legacyCurrentDb) &&
        isLayoutReceiptFileIdentity(receipt.target));
}
function isLayoutReceiptFileIdentity(value) {
    if (value === 'missing')
        return true;
    if (!value || typeof value !== 'object')
        return false;
    const identity = value;
    return (typeof identity.dev === 'number' &&
        typeof identity.ino === 'number' &&
        typeof identity.birthtimeMs === 'number');
}
function isLayoutReceiptSourceIdentity(value) {
    if (!isLayoutReceiptFileIdentity(value))
        return false;
    if (value === 'missing')
        return true;
    const identity = value;
    return (typeof identity.sizeBytes === 'number' &&
        typeof identity.mtimeMs === 'number' &&
        isLayoutReceiptWalSample(identity.wal));
}
function isLayoutReceiptWalSample(value) {
    if (value === 'missing')
        return true;
    if (!value || typeof value !== 'object')
        return false;
    const sample = value;
    return typeof sample.sizeBytes === 'number' && typeof sample.mtimeMs === 'number';
}
function isSameFileIdentity(left, right) {
    if (left === 'missing' || right === 'missing')
        return left === right;
    return left.dev === right.dev && left.ino === right.ino && left.birthtimeMs === right.birthtimeMs;
}
function isSameSourceIdentity(left, right) {
    if (left === 'missing' || right === 'missing')
        return left === right;
    return (isSameFileIdentity(left, right) &&
        left.sizeBytes === right.sizeBytes &&
        left.mtimeMs === right.mtimeMs &&
        isSameWalSample(left.wal, right.wal));
}
function isSameWalSample(left, right) {
    if (left === 'missing' || right === 'missing')
        return left === right;
    return left.sizeBytes === right.sizeBytes && left.mtimeMs === right.mtimeMs;
}
function ensureManagedDirectory(dirPath) {
    fs.mkdirSync(dirPath, { recursive: true });
    if (fs.lstatSync(dirPath).isSymbolicLink()) {
        throw new Error(`Unsafe layout receipt directory: ${dirPath}`);
    }
}
function ensureWriteTargetSafe(filePath) {
    try {
        const stats = fs.lstatSync(filePath);
        if (stats.isSymbolicLink() || !stats.isFile()) {
            throw new Error(`Unsafe layout receipt target: ${filePath}`);
        }
    }
    catch (err) {
        if (err.code === 'ENOENT')
            return;
        throw err;
    }
}
//# sourceMappingURL=layout-receipt.js.map