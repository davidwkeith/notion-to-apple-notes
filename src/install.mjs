// Stores the Notion token in Keychain, runs one foreground sync, and loads a
// LaunchAgent that runs `notion-to-apple-notes sync` on an interval.

import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sync, SERVICE } from './sync.mjs';

export const LABEL = 'io.dwk.notion-to-apple-notes';
export const PLIST = join(homedir(), `Library/LaunchAgents/${LABEL}.plist`);
const LOG = join(homedir(), `Library/Logs/${SERVICE}.log`);
const CLI = fileURLToPath(new URL('../bin/cli.mjs', import.meta.url));

const escXml = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

function hasKeychainToken() {
  try {
    execFileSync('security', ['find-generic-password', '-s', SERVICE], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function promptSecret(prompt) {
  if (!process.stdin.isTTY) throw new Error('No token in Keychain and no TTY to prompt on. Set NOTION_TOKEN or run interactively.');
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  let value = '';
  for await (const chunk of process.stdin) {
    for (const ch of chunk.toString('utf8')) {
      if (ch === '\r' || ch === '\n' || ch === '\u0004') {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdout.write('\n');
        return value;
      }
      if (ch === '\u0003') process.exit(130); // ^C
      if (ch === '\u007f') value = value.slice(0, -1); // backspace
      else value += ch;
    }
  }
  return value;
}

export async function install({ interval = 900 } = {}) {
  if (!Number.isInteger(interval) || interval <= 0) throw new Error(`Invalid interval: ${interval}`);

  if (!hasKeychainToken()) {
    const token = process.env.NOTION_TOKEN ?? (await promptSecret('Notion installation access token: '));
    if (!token) throw new Error('Empty token.');
    execFileSync('security', ['add-generic-password', '-s', SERVICE, '-a', process.env.USER ?? 'user', '-w', token]);
  }

  console.log('First run in the foreground — approve the prompt to let this terminal control Notes.');
  await sync();
  if (process.exitCode) throw new Error('First sync reported failures; not loading the LaunchAgent.');

  if (CLI.includes('/_npx/')) {
    console.warn(
      'warning: running from the npx cache, which npm may prune. Install globally instead:\n' +
        '  npm install -g @dwk/notion-to-apple-notes && notion-to-apple-notes install',
    );
  }

  await mkdir(dirname(PLIST), { recursive: true });
  await mkdir(dirname(LOG), { recursive: true });
  await writeFile(
    PLIST,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escXml(process.execPath)}</string>
    <string>${escXml(CLI)}</string>
    <string>sync</string>
  </array>
  <key>StartInterval</key><integer>${interval}</integer>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${escXml(LOG)}</string>
  <key>StandardErrorPath</key><string>${escXml(LOG)}</string>
</dict>
</plist>
`,
  );

  const domain = `gui/${process.getuid()}`;
  try {
    execFileSync('launchctl', ['bootout', `${domain}/${LABEL}`], { stdio: 'ignore' });
  } catch {
    // not loaded yet
  }
  execFileSync('launchctl', ['bootstrap', domain, PLIST], { stdio: 'inherit' });

  console.log(`Loaded ${LABEL} (every ${interval}s). Logs: ${LOG}`);
  console.log(
    "If the log shows 'Not authorized to send Apple events' (-1743), allow node → Notes in\n" +
      `System Settings › Privacy & Security › Automation, then: launchctl kickstart ${domain}/${LABEL}`,
  );
}
