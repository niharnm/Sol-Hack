#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { createAdminAuth } from '../src/admin-auth.js';

function usage() {
  return `Usage:
  motto setup [--data-dir <path>] [--url <origin>] [--open] [--json]
  motto pair --url <origin> [--data-dir <path>] [--open] [--json]
  motto status [--data-dir <path>] [--json]
  motto start [--data-dir <path>]

First run creates a 256-bit admin token in a private file. A pairing URL grants
one browser an eight-hour, read-only administration session without exposing
the long-lived token to browser JavaScript.`;
}

function parse(argv) {
  const command = argv[0] ?? 'help';
  const options = { dataDir: process.env.DATA_DIR ?? 'data', json: false, open: false };
  for (let index = 1; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--json') options.json = true;
    else if (arg === '--open') options.open = true;
    else if (arg === '--data-dir' || arg === '--url') {
      const value = argv[++index];
      if (!value) throw new Error(`${arg} requires a value`);
      if (arg === '--data-dir') options.dataDir = value;
      else options.url = value;
    } else throw new Error(`Unknown option: ${arg}`);
  }
  return { command, options };
}

function pairingUrl(origin, code) {
  let url;
  try {
    url = new URL(origin);
  } catch {
    throw new Error('--url must be an HTTP or HTTPS origin');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('--url must be an HTTP or HTTPS origin');
  }
  url.hash = new URLSearchParams({ pair: code }).toString();
  return url.toString();
}

function openBrowser(url) {
  if (process.env.CI || !process.stdout.isTTY) return false;
  const [command, args] = process.platform === 'darwin'
    ? ['open', [url]]
    : process.platform === 'win32'
      ? ['cmd.exe', ['/d', '/s', '/c', 'start', '', url]]
      : ['xdg-open', [url]];
  const child = spawn(command, args, { detached: true, stdio: 'ignore', shell: false });
  child.unref();
  return true;
}

function print(result, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (result.message) process.stdout.write(`${result.message}\n`);
  if (result.token_file) process.stdout.write(`Admin token: ${result.token_file}\n`);
  if (result.pairing_url) process.stdout.write(`Pair browser: ${result.pairing_url}\n`);
}

async function main(argv) {
  let parsed;
  try {
    parsed = parse(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n${usage()}\n`);
    return 2;
  }
  const { command, options } = parsed;
  if (command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  if (!['setup', 'pair', 'status', 'start'].includes(command)) {
    process.stderr.write(`Unknown command: ${command}\n${usage()}\n`);
    return 2;
  }

  const dataDir = resolve(options.dataDir);
  let auth;
  try {
    auth = createAdminAuth({ dataDir });
  } catch (error) {
    process.stderr.write(`${error.code ?? error.message}\n`);
    return 1;
  }

  if (command === 'start') {
    process.env.DATA_DIR = dataDir;
    await import('../src/server.js');
    return 0;
  }

  if (command === 'status') {
    const status = auth.status();
    print({ ...status, message: 'Motto administration is initialized.' }, options.json);
    return 0;
  }

  let pairing;
  if (command === 'pair' || options.url) {
    if (!options.url) {
      process.stderr.write('pair requires --url <origin>\n');
      return 2;
    }
    try {
      const created = auth.createPairing();
      pairing = pairingUrl(options.url, created.code);
    } catch (error) {
      process.stderr.write(`${error.code ?? error.message}\n`);
      return 1;
    }
  }

  const result = {
    initialized: true,
    generated: auth.generated,
    token_file: auth.status().token_file,
    ...(pairing ? { pairing_url: pairing } : {}),
    opened: pairing && options.open ? openBrowser(pairing) : false,
    message: auth.generated ? 'Created Motto administration credentials.' : 'Motto administration credentials already exist.',
  };
  print(result, options.json);
  return 0;
}

process.exitCode = await main(process.argv.slice(2));
