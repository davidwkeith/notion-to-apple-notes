# @dwk/notion-to-apple-notes

One-way sync from Notion to Apple Notes. It runs every 15 minutes through launchd. Notion is the source of truth, so any edits you make to a synced note in Notes get overwritten.

**Requires** macOS 26+ and Node 20+.

## Setup

1. Create an internal connection at <https://app.notion.com/developers/connections> with the **Read content** capability, and copy its installation access token ([guide](https://developers.notion.com/guides/get-started/internal-connections)).
2. Share the pages you want synced with the connection. On each page, open ••• › Connections › Add connection. Subpages inherit access ([help](https://www.notion.com/help/add-and-manage-connections-with-the-api)).
3. Install and set up:

   ```sh
   npm install -g @dwk/notion-to-apple-notes
   notion-to-apple-notes install
   ```

   `install` prompts for the token and saves it to Keychain (service `notion-to-apple-notes`), does one sync in the foreground (approve the prompt that lets your terminal control Notes), then loads the LaunchAgent `io.dwk.notion-to-apple-notes`.

   Install globally rather than through `npx` — the LaunchAgent points at the installed files, and npm prunes the `npx` cache.

## Behavior

- Every page shared with the connection becomes one note in the **Notion** folder of your iCloud account (or the default Notes account if there's no iCloud one).
- A note is only rewritten when the page's `last_edited_time` changes. Page ID → note ID is stored in `~/Library/Application Support/notion-to-apple-notes/state.json`.
- If you delete a synced note in Notes, it gets recreated on the next run. If you unshare a page in Notion, its note is kept and the log reports it.
- Images are downloaded and embedded, because Notion's file URLs expire after about an hour.
- Callouts become block quotes, toggles are expanded, columns are stacked, and child pages and mentions become links. Bookmarks and embeds become plain links, because the [markdown endpoint](https://developers.notion.com/reference/retrieve-page-markdown) doesn't support them yet.

## Options

| Env / flag | Default |
|---|---|
| `NOTES_FOLDER` | `Notion` |
| `NOTES_ACCOUNT` | `iCloud` if present, else the default account |
| `EMBED_IMAGES=0` | images embedded |
| `--interval <s>` (install) | `900` |
| `--dry-run` `--force` `--verbose` (sync) | — |

Env vars for the LaunchAgent go in an `EnvironmentVariables` dict in `~/Library/LaunchAgents/io.dwk.notion-to-apple-notes.plist`.

## Ops

```sh
tail -f ~/Library/Logs/notion-to-apple-notes.log
launchctl kickstart gui/$(id -u)/io.dwk.notion-to-apple-notes   # run now
notion-to-apple-notes sync --dry-run --verbose
notion-to-apple-notes uninstall
```

If the log shows error **-1743** (not authorized), allow `node` to control Notes in System Settings › Privacy & Security › Automation, then kickstart the agent.

## Migrating from the old notion-notes-sync script

This package uses new identifiers, so nothing carries over: run the old `./uninstall.sh`, delete its Keychain item (`security delete-generic-password -s notion-notes-sync`) and state (`rm -r ~/Library/Application\ Support/notion-notes-sync`), and delete the old Notion folder in Notes — otherwise the first run recreates every note alongside the old copies.

## License

[ISC](LICENSE)
