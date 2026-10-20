/** Fixed askpass entry. Only the OpenSSH prompt travels in argv, never the password. */
import { connect } from "node:net";
const socketPath = process.env.MAVIS_SSH_ASKPASS_SOCKET;
const token = process.env.MAVIS_SSH_ASKPASS_TOKEN;
if (!socketPath || !token)
    process.exit(1);
const prompt = process.argv[2];
if (process.argv.length !== 3 || !prompt || prompt.length > 4096)
    process.exit(1);
const socket = connect(socketPath);
const timer = setTimeout(() => process.exit(1), 123000);
let output = Buffer.alloc(0);
socket.on('connect', () => socket.write(JSON.stringify({ token, prompt, hint: process.env.SSH_ASKPASS_PROMPT }) + '\n'));
socket.on('data', (chunk) => {
    output = Buffer.concat([output, chunk]);
    if (output.length > 1024)
        process.exit(1);
});
socket.on('error', () => process.exit(1));
socket.on('end', () => {
    clearTimeout(timer);
    if (!output.length || output[output.length - 1] !== 10)
        process.exit(1);
    process.stdout.write(output, () => {
        output.fill(0);
        process.exit(0);
    });
});
