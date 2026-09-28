#!/usr/bin/env node
// CLI for @dwk/notion-to-apple-notes.
// Usage: notion-to-apple-notes <sync|install|uninstall> [options]

import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

const USAGE = `Usage: notion-to-apple-notes <command> [options]

Commands:
  sync         Sync Notion pages to Apple Notes once
  install      Store the Notion token in Keychain, sync once, and load the launchd agent
  uninstall    Unload the launchd agent

Options (sync):
  --dry-run              Report what would change without touching Notes
  --force                Rewrite every note, even unchanged ones
  --verbose              Log retries and skipped images

Options (install):
  --interval <seconds>   Sync interval for the launchd agent (default 900)

General:
  -h, --help             Show this help
  -v, --version          Show the package version
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    'dry-run': { type: 'boolean', default: false },
    force: { type: 'boolean', default: false },
    verbose: { type: 'boolean', default: false },
    interval: { type: 'string' },
    help: { type: 'boolean', short: 'h', default: false },
    version: { type: 'boolean', short: 'v', default: false },
  },
});

if (values.version) {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  console.log(pkg.version);
  process.exit(0);
}

const command = positionals[0];
if (values.help || !command) {
  console.log(USAGE);
  process.exit(command ? 0 : values.help ? 0 : 1);
}

if (process.platform !== 'darwin') {
  console.error(
    'This tool requires macOS: Apple Notes is only writable through Apple events,\n' +
      'and iCloud has no public Notes API. Run it on a Mac signed into iCloud.',
  );
  process.exit(1);
}

try {
  switch (command) {
    case 'sync': {
      const { sync } = await import('../src/sync.mjs');
      await sync({ dryRun: values['dry-run'], force: values.force, verbose: values.verbose });
      break;
    }
    case 'install': {
      const { install } = await import('../src/install.mjs');
      await install({ interval: Number(values.interval ?? process.env.INTERVAL ?? 900) });
      break;
    }
    case 'uninstall': {
      const { uninstall } = await import('../src/uninstall.mjs');
      await uninstall();
      break;
    }
    default:
      console.error(`Unknown command: ${command}\n\n${USAGE}`);
      process.exit(1);
  }
} catch (e) {
  console.error(`fatal: ${e.message}`);
  process.exit(1);
}
