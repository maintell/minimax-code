/** Preview budgets, shared by transport and renderer before allocating document bytes. */
export const WORD_PREVIEW_MAX_BYTES = 30 * 1024 * 1024;
export const WORKBOOK_PREVIEW_MAX_BYTES = 30 * 1024 * 1024;
export const PDF_PREVIEW_MAX_BYTES = 100 * 1024 * 1024;
export const OFFICE_PREVIEW_TOO_LARGE = 'OFFICE_PREVIEW_TOO_LARGE';
export function officePreviewByteLimit(fileName, mimeType = '') {
    const extension = /\.([^.\\/]+)$/u.exec(fileName)?.[1]?.toLowerCase();
    if (['doc', 'docx'].includes(extension ?? ''))
        return WORD_PREVIEW_MAX_BYTES;
    if (['xls', 'xlsx', 'xlsm', 'csv'].includes(extension ?? ''))
        return WORKBOOK_PREVIEW_MAX_BYTES;
    if (extension === 'pdf')
        return PDF_PREVIEW_MAX_BYTES;
    const mime = mimeType.split(';', 1)[0]?.trim().toLowerCase();
    if (mime === 'application/pdf')
        return PDF_PREVIEW_MAX_BYTES;
    if (mime === 'application/msword' || mime?.includes('wordprocessingml'))
        return WORD_PREVIEW_MAX_BYTES;
    if (mime === 'text/csv' ||
        mime?.startsWith('application/vnd.ms-excel') ||
        mime?.includes('spreadsheetml'))
        return WORKBOOK_PREVIEW_MAX_BYTES;
    return undefined;
}
/** Upper bound without decoding or allocating a second copy of the encoded content. */
export function base64ByteLength(content) {
    const padding = content.endsWith('==') ? 2 : content.endsWith('=') ? 1 : 0;
    return Math.max(0, Math.floor((content.length * 3) / 4) - padding);
}
//# sourceMappingURL=office-preview-limits.js.map