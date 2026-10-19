/** Selects one authoritative source without falling through after a selected reader fails. */
export async function selectCanonicalHistorySource(readers) {
    const target = await readers.readTarget();
    if (target !== undefined)
        return { source: 'target', records: target };
    const ledgerSnapshot = await readers.readAuthoritativeLedgerSnapshot();
    if (ledgerSnapshot !== undefined) {
        return { source: 'ledger-snapshot', records: ledgerSnapshot };
    }
    const rows = await readers.readSqliteRows();
    if (rows.length > 0)
        return { source: 'sqlite-rows', records: rows };
    const blob = await readers.readSqliteBlob();
    return blob.length > 0
        ? { source: 'sqlite-blob', records: blob }
        : { source: 'empty', records: [] };
}
//# sourceMappingURL=canonical-history-source.js.map