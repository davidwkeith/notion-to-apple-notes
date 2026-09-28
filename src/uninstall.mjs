// Stops the LaunchAgent. Leaves your notes, state file, and Keychain item alone.

import { execFileSync } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { SERVICE } from './sync.mjs';
import { LABEL, PLIST } from './install.mjs';

export async function uninstall() {
  try {
    execFileSync('launchctl', ['bootout', `gui/${process.getuid()}/${LABEL}`], { stdio: 'ignore' });
  } catch {
    // wasn't loaded
  }
  await rm(PLIST, { force: true });
  console.log(`Unloaded ${LABEL}.`);
  console.log('Optional cleanup:');
  console.log(`  security delete-generic-password -s ${SERVICE}`);
  console.log(`  rm -r ~/Library/Application\\ Support/${SERVICE} ~/Library/Logs/${SERVICE}.log`);
}
