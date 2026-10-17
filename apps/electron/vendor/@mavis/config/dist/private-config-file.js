import fs from 'node:fs';
/** Config documents and their copies can contain plaintext credentials. */
export const PRIVATE_CONFIG_FILE_MODE = 0o600;
/** Remove non-owner access without changing an owner's read-only policy. */
export function restrictConfigFileSync(filePath) {
    if (process.platform === 'win32')
        return;
    const mode = fs.statSync(filePath).mode;
    // Already-private files may live on read-only mounts or be immutable.
    if ((mode & 0o077) === 0)
        return;
    fs.chmodSync(filePath, mode & 0o700);
}
/** Restrict access before truncating or writing any secret-bearing content. */
export function writePrivateConfigFileSync(filePath, content, exclusive = false) {
    // Windows 的追加句柄不能用于 ftruncate；打开时也不能提前截断，
    // 必须等权限收紧成功后再清空已有内容。
    const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | (exclusive ? fs.constants.O_EXCL : 0);
    const fd = fs.openSync(filePath, flags, PRIVATE_CONFIG_FILE_MODE);
    try {
        fs.fchmodSync(fd, PRIVATE_CONFIG_FILE_MODE);
        fs.ftruncateSync(fd, 0);
        fs.writeFileSync(fd, content);
    }
    finally {
        fs.closeSync(fd);
    }
}
//# sourceMappingURL=private-config-file.js.map