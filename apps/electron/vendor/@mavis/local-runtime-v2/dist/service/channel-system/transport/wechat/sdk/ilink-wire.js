const ILINK_CHANNEL_VERSION = '2.4.6';
const ILINK_APP_ID = 'bot';
const ILINK_BOT_AGENT = `Mavis/${ILINK_CHANNEL_VERSION}`;
const ILINK_APP_CLIENT_VERSION = encodeIlinkClientVersion(ILINK_CHANNEL_VERSION);
function encodeIlinkClientVersion(version) {
    const [major = 0, minor = 0, patch = 0] = version
        .split('.')
        .map((part) => Number.parseInt(part, 10))
        .map((part) => (Number.isFinite(part) ? part : 0));
    return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}
export function buildIlinkCommonHeaders() {
    return {
        'iLink-App-Id': ILINK_APP_ID,
        'iLink-App-ClientVersion': String(ILINK_APP_CLIENT_VERSION),
    };
}
export function buildIlinkBaseInfo() {
    return {
        channel_version: ILINK_CHANNEL_VERSION,
        bot_agent: ILINK_BOT_AGENT,
    };
}
//# sourceMappingURL=ilink-wire.js.map