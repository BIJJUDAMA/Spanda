const { spawn } = require('child_process');
const path = require('path');
const os = require('os');

const cargoBin = path.join(os.homedir(), '.cargo', 'bin');
const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
const currentPath = process.env[pathKey] || '';
const newPath = currentPath.includes(cargoBin) ? currentPath : `${cargoBin};${currentPath}`;

const env = { ...process.env, [pathKey]: newPath };
const cliScript = require.resolve('@tauri-apps/cli/tauri.js');

const child = spawn(process.execPath, [cliScript, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env,
});

child.on('exit', (code) => {
  process.exit(code ?? 0);
});
