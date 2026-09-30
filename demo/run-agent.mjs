import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
if (!args.length) throw new Error('Supply a query and --max-spend. For Devnet use npm run buy:devnet from motto/.');
const child = spawn(process.execPath, [fileURLToPath(new URL('../motto/buyer/buy.js', import.meta.url)), ...args], { stdio: 'inherit' });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
