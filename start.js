'use strict';
// Starts server.js and starts it again when it asks for that (exit code 75), for example after
// settings were changed on the admin page. Stop signals are passed on, so the server can save its data.
const { spawn } = require('child_process');
const path = require('path');

let child = null, stopping = false;
function run() {
  child = spawn(process.execPath, [path.join(__dirname, 'server.js')], { stdio: 'inherit', env: Object.assign({}, process.env, { DEX_SUPERVISED: '1' }) });
  child.on('exit', (code, signal) => {
    if (!stopping && code === 75) { setTimeout(run, 300); return; }
    process.exit(code == null ? (signal ? 1 : 0) : code);
  });
}
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { stopping = true; if (child) child.kill(sig); else process.exit(0); });
run();
