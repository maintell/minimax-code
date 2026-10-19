/**
 * 版本号比较工具函数
 */

/**
 * 比较简单版本号部分（如 3.0.3）
 */
function compareSimpleParts(v1, v2) {
    const parts1 = v1.split('.').map(Number);
    const parts2 = v2.split('.').map(Number);
    for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
        const p1 = parts1[i] || 0;
        const p2 = parts2[i] || 0;
        if (p1 > p2)
            return 1;
        if (p1 < p2)
            return -1;
    }
    return 0;
}
/**
 * 比较预发布标签（如 test.1, beta.2）
 */
function comparePreRelease(pre1, pre2) {
    const parts1 = pre1.split('.');
    const parts2 = pre2.split('.');
    for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
        const p1 = parts1[i] || '';
        const p2 = parts2[i] || '';
        // 尝试作为数字比较
        const n1 = parseInt(p1, 10);
        const n2 = parseInt(p2, 10);
        if (!isNaN(n1) && !isNaN(n2)) {
            if (n1 > n2)
                return 1;
            if (n1 < n2)
                return -1;
        }
        else {
            // 字符串比较
            if (p1 > p2)
                return 1;
            if (p1 < p2)
                return -1;
        }
    }
    return 0;
}
/**
 * 比较两个版本号
 * @param v1 版本号1
 * @param v2 版本号2
 * @returns 1 if v1 > v2, -1 if v1 < v2, 0 if equal
 *
 * @example
 * compareVersions('3.0.3', '3.0.2') // 1
 * compareVersions('3.0.2', '3.0.3') // -1
 * compareVersions('3.0.3', '3.0.3') // 0
 * compareVersions('3.0.3-test.1', '3.0.3-test.2') // -1
 */
export function compareVersions(v1, v2) {
    // 分离主版本号和预发布标签
    const [main1, pre1] = v1.split('-');
    const [main2, pre2] = v2.split('-');
    // 先比较主版本号
    const mainResult = compareSimpleParts(main1, main2);
    if (mainResult !== 0)
        return mainResult;
    // 主版本号相同，比较预发布标签
    // 没有预发布标签的版本 > 有预发布标签的版本（如 3.0.3 > 3.0.3-test.1）
    if (!pre1 && pre2)
        return 1;
    if (pre1 && !pre2)
        return -1;
    if (!pre1 && !pre2)
        return 0;
    // 都有预发布标签，比较标签
    return comparePreRelease(pre1, pre2);
}
/**
 * 检查 v1 是否小于 v2
 */
export function isVersionLower(v1, v2) {
    if (!v1 || !v2)
        return true;
    return compareVersions(v1, v2) < 0;
}
/**
 * 检查 v1 是否大于 v2
 */
export function isVersionHigher(v1, v2) {
    if (!v1 || !v2)
        return false;
    return compareVersions(v1, v2) > 0;
}
