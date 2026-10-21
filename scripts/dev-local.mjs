import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const children = [
    spawn('python3', ['server/ros_stream.py', '--demo'], { cwd: root, stdio: 'inherit' }),
    spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1'], { cwd: root, stdio: 'inherit' })
];
let closing = false;
function close(code = 0) {
    if (closing) return;
    closing = true;
    children.forEach(child => child.kill('SIGTERM'));
    process.exitCode = code;
}
for (const child of children) {
    child.on('error', error => { console.error(error.message); close(1); });
    child.on('exit', code => close(code || 0));
}
process.on('SIGINT', () => close());
process.on('SIGTERM', () => close());
