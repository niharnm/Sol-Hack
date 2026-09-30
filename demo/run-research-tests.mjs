import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const child = spawn(process.execPath, ['--test', 'test/digital.test.js', 'test/buyer.test.js', 'test/server.test.js', 'test/store.test.js', 'test/devnet-purchase.test.js'],
  { cwd: fileURLToPath(new URL('../motto', import.meta.url)), stdio: 'inherit' });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
