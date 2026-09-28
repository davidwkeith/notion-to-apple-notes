// JXA: create or update one Apple Note from a JSON job file.
// Usage: osascript -l JavaScript notes-upsert.js /path/to/job.json
// job = { account: "" | "iCloud", folder: "Notion", noteId: "x-coredata://…" | null, html: "<h1>…" }
// Prints the note's id.

ObjC.import('Foundation');

function run(argv) {
  const text = $.NSString.stringWithContentsOfFileEncodingError(argv[0], $.NSUTF8StringEncoding, null);
  if (!text) throw new Error('Cannot read job file: ' + argv[0]);
  const job = JSON.parse(ObjC.unwrap(text));

  const Notes = Application('Notes');
  // Prefer iCloud so notes sync across devices; NOTES_ACCOUNT overrides, and
  // Macs without an iCloud Notes account fall back to the default account.
  const account = job.account
    ? Notes.accounts.byName(job.account)
    : Notes.accounts.whose({ name: 'iCloud' }).length > 0
      ? Notes.accounts.byName('iCloud')
      : Notes.defaultAccount();

  // Existing note, as long as it wasn't moved to Recently Deleted.
  if (job.noteId) {
    try {
      const note = Notes.notes.byId(job.noteId);
      const where = note.container().name();
      if (where !== 'Recently Deleted') {
        note.body = job.html;
        return note.id();
      }
    } catch (e) {
      // deleted or unreachable → recreate below
    }
  }

  let folder;
  if (account.folders.whose({ name: job.folder }).length > 0) {
    folder = account.folders.byName(job.folder);
  } else {
    folder = Notes.make({ new: 'folder', at: account, withProperties: { name: job.folder } });
  }
  const created = Notes.make({ new: 'note', at: folder, withProperties: { body: job.html } });
  return created.id();
}
