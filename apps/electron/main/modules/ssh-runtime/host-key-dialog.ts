import { BrowserWindow, dialog } from "electron";
import { isEn } from "../../config/env.js";
/** The foreground add request owns both the dialog and its cancellation. */
export function hostKeyConfirmation(sender) {
    return async (challenge, signal) => {
        if (signal.aborted || sender.isDestroyed())
            return false;
        const parent = BrowserWindow.fromWebContents(sender);
        if (!parent || parent.isDestroyed())
            return false;
        const { response } = await dialog.showMessageBox(parent, {
            type: 'question',
            title: isEn ? 'Trust SSH host' : '信任 SSH 主机',
            message: isEn ? 'Trust this host key and continue?' : '信任此主机密钥并继续连接？',
            detail: [
                `${challenge.hostname}:${challenge.port}`,
                `${challenge.keyType} ${challenge.fingerprint}`,
                isEn
                    ? 'Verify this fingerprint with the host administrator. If you trust it, OpenSSH will remember this key before password authentication.'
                    : '请向主机管理员核对以上指纹。确认信任后，OpenSSH 会记住此密钥，再进行密码认证。',
            ].join('\n\n'),
            buttons: isEn ? ['Cancel', 'Trust and connect'] : ['取消', '信任并连接'],
            defaultId: 0,
            cancelId: 0,
            noLink: true,
            signal,
        });
        return response === 1 && !signal.aborted && !sender.isDestroyed();
    };
}
