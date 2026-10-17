export var SigninDayStatus;
(function (SigninDayStatus) {
    SigninDayStatus[SigninDayStatus["Upcoming"] = 1] = "Upcoming";
    SigninDayStatus[SigninDayStatus["Claimable"] = 2] = "Claimable";
    SigninDayStatus[SigninDayStatus["Claimed"] = 3] = "Claimed";
    SigninDayStatus[SigninDayStatus["Disabled"] = 4] = "Disabled";
})(SigninDayStatus || (SigninDayStatus = {}));
export var SigninClaimResult;
(function (SigninClaimResult) {
    SigninClaimResult[SigninClaimResult["Claimed"] = 1] = "Claimed";
    SigninClaimResult[SigninClaimResult["AlreadyClaimed"] = 2] = "AlreadyClaimed";
})(SigninClaimResult || (SigninClaimResult = {}));
export var SigninPanelScene;
(function (SigninPanelScene) {
    SigninPanelScene[SigninPanelScene["Unknown"] = 0] = "Unknown";
    SigninPanelScene[SigninPanelScene["First"] = 1] = "First";
    SigninPanelScene[SigninPanelScene["Active"] = 2] = "Active";
    SigninPanelScene[SigninPanelScene["Completed"] = 3] = "Completed";
    SigninPanelScene[SigninPanelScene["Broken"] = 4] = "Broken";
})(SigninPanelScene || (SigninPanelScene = {}));
const DAY_STATUSES = new Set([
    SigninDayStatus.Upcoming,
    SigninDayStatus.Claimable,
    SigninDayStatus.Claimed,
    SigninDayStatus.Disabled,
]);
const CLAIM_RESULTS = new Set([
    SigninClaimResult.Claimed,
    SigninClaimResult.AlreadyClaimed,
]);
const PANEL_SCENES = new Set([
    SigninPanelScene.Unknown,
    SigninPanelScene.First,
    SigninPanelScene.Active,
    SigninPanelScene.Completed,
    SigninPanelScene.Broken,
]);
export function isSigninPanelClaimable(panel) {
    return Boolean(panel?.days.some((day) => day.status === SigninDayStatus.Claimable));
}
export function isSigninPanelClaimedToday(panel) {
    return Boolean(panel?.days.some((day) => day.is_today && day.status === SigninDayStatus.Claimed));
}
export function getCurrentSigninStreak(days) {
    const sortedDays = [...days].sort((left, right) => left.day_no - right.day_no);
    const todayIndex = sortedDays.findIndex((day) => day.is_today);
    if (todayIndex < 0)
        return 0;
    const todayStatus = sortedDays[todayIndex]?.status;
    let index = todayStatus === SigninDayStatus.Claimed
        ? todayIndex
        : todayStatus === SigninDayStatus.Claimable
            ? todayIndex - 1
            : -1;
    if (index < 0)
        return 0;
    let streak = 0;
    for (; index >= 0; index -= 1) {
        if (sortedDays[index]?.status !== SigninDayStatus.Claimed)
            break;
        streak += 1;
    }
    return streak;
}
export function validateSigninPanel(value) {
    const panel = value;
    const days = panel?.days;
    const dayNumbers = new Set();
    let claimableDays = 0;
    let todayDays = 0;
    const validDays = Array.isArray(days) &&
        days.length === 7 &&
        days.every((day) => {
            if (!day || typeof day !== 'object')
                return false;
            const item = day;
            const dayNo = item.day_no;
            if (typeof dayNo !== 'number' ||
                !Number.isInteger(dayNo) ||
                dayNo < 1 ||
                dayNo > 7 ||
                dayNumbers.has(dayNo)) {
                return false;
            }
            if (typeof item.points !== 'number' ||
                !Number.isFinite(item.points) ||
                item.points < 0 ||
                (item.bonus_points !== undefined &&
                    (typeof item.bonus_points !== 'number' ||
                        !Number.isFinite(item.bonus_points) ||
                        item.bonus_points < 0)) ||
                typeof item.is_today !== 'boolean' ||
                !DAY_STATUSES.has(item.status)) {
                return false;
            }
            dayNumbers.add(dayNo);
            if (item.status === SigninDayStatus.Claimable)
                claimableDays += 1;
            if (item.is_today)
                todayDays += 1;
            return true;
        });
    if (panel === null ||
        typeof panel !== 'object' ||
        !PANEL_SCENES.has(panel.scene) ||
        !validDays ||
        claimableDays > 1 ||
        todayDays > 1) {
        throw new Error('Invalid sign-in panel');
    }
    return panel;
}
export function validateClaimSigninData(value) {
    const data = value;
    const valid = data !== null &&
        typeof data === 'object' &&
        typeof data.claim_id === 'string' &&
        data.claim_id.length > 0 &&
        CLAIM_RESULTS.has(data.claim_result) &&
        Number.isInteger(data.day_no) &&
        (data.day_no ?? 0) >= 1 &&
        (data.day_no ?? 8) <= 7 &&
        typeof data.points === 'number' &&
        Number.isFinite(data.points) &&
        data.points >= 0 &&
        typeof data.expire_at_ms === 'number' &&
        Number.isFinite(data.expire_at_ms);
    if (!valid) {
        throw new Error('Invalid sign-in claim response');
    }
    return {
        ...data,
        panel: validateSigninPanel(data.panel),
    };
}
//# sourceMappingURL=daily-signin.js.map