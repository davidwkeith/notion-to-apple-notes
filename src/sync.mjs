// One-way sync: Notion pages shared with your integration → Apple Notes.
// Notion is the source of truth; edits made to synced notes in Notes get overwritten.
//
// Env (all optional):
//   NOTION_TOKEN     integration secret (otherwise read from Keychain service "notion-to-apple-notes")
//   NOTES_FOLDER     Notes folder to sync into (default "Notion")
//   NOTES_ACCOUNT    Notes account name (default: iCloud if present, else Notes' default account)
//   EMBED_IMAGES     "0" to skip inlining images (default on)
//   STATE_FILE       default ~/Library/Application Support/notion-to-apple-notes/state.json

import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));

export const SERVICE = 'notion-to-apple-notes';

const API = process.env.NOTION_API_BASE ?? 'https://api.notion.com/v1';
const NOTION_VERSION = '2026-03-11';
const FOLDER = process.env.NOTES_FOLDER ?? 'Notion';
const ACCOUNT = process.env.NOTES_ACCOUNT ?? '';
const EMBED_IMAGES = process.env.EMBED_IMAGES !== '0';
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const STATE_FILE =
  process.env.STATE_FILE ??
  join(homedir(), `Library/Application Support/${SERVICE}/state.json`);

let VERBOSE = false;
const log = (...a) => console.log(new Date().toISOString(), ...a);
const debug = (...a) => VERBOSE && log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- token ----------
function getToken() {
  if (process.env.NOTION_TOKEN) return process.env.NOTION_TOKEN;
  try {
    return execFileSync('security', ['find-generic-password', '-s', SERVICE, '-w'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    throw new Error(
      `No Notion token: set NOTION_TOKEN or run \`notion-to-apple-notes install\` to store it in Keychain.`,
    );
  }
}

// ---------- Notion API (≈3 req/s, retries on 429/5xx) ----------
let TOKEN;
let lastCall = 0;
async function notion(path, { method = 'GET', body } = {}) {
  TOKEN ??= getToken();
  for (let attempt = 1; ; attempt++) {
    const wait = lastCall + 350 - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    const res = await fetch(API + path, {
      method,
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Notion-Version': NOTION_VERSION,
        ...(body && { 'Content-Type': 'application/json' }),
      },
      body: body && JSON.stringify(body),
    });
    if (res.ok) return res.json();
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= 5) {
      throw new Error(`Notion ${method} ${path} → ${res.status}: ${await res.text()}`);
    }
    const retryAfter = Number(res.headers.get('retry-after')) || 2 ** attempt;
    debug(`Notion ${res.status}, retrying in ${retryAfter}s`);
    await sleep(retryAfter * 1000);
  }
}

async function* allSharedPages() {
  let cursor;
  do {
    const page = await notion('/search', {
      method: 'POST',
      body: {
        filter: { property: 'object', value: 'page' },
        sort: { timestamp: 'last_edited_time', direction: 'descending' },
        page_size: 100,
        ...(cursor && { start_cursor: cursor }),
      },
    });
    yield* page.results;
    cursor = page.has_more ? page.next_cursor : undefined;
  } while (cursor);
}

const titleOf = (page) =>
  Object.values(page.properties ?? {})
    .find((p) => p.type === 'title')
    ?.title.map((t) => t.plain_text)
    .join('')
    .trim() || 'Untitled';

// ---------- Notion enhanced markdown → CommonMark ----------
// https://developers.notion.com/guides/data-apis/enhanced-markdown
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const attr = (tag, name) => tag.match(new RegExp(`${name}="([^"]*)"`))?.[1];
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s/;

export function notionToCommonMark(md) {
  // Inline rewrites (safe outside code fences; applied per line below).
  const inline = (line) =>
    line
      // links to pages, databases, mentions, media, unknown blocks
      .replace(/<(page|database|mention-page|mention-database|mention-data-source|mention-agent)\b([^>]*)>([\s\S]*?)<\/\1>/g,
        (_, _t, a, text) => `[${text || 'Untitled'}](${attr(a, 'url') ?? ''})`)
      .replace(/<mention-user\b[^>]*>([\s\S]*?)<\/mention-user>/g, '@$1')
      .replace(/<mention-date\b([^>]*)\/>/g, (_, a) =>
        [attr(a, 'start'), attr(a, 'startTime')].filter(Boolean).join(' ') +
        (attr(a, 'end') ? ` – ${attr(a, 'end')}` : ''))
      .replace(/<(audio|video|file|pdf)\b([^>]*)>([\s\S]*?)<\/\1>/g,
        (_, kind, a, cap) => `[${cap || kind}](${attr(a, 'src') ?? ''})`)
      .replace(/<(audio|video|file|pdf)\b([^>]*)\/>/g, (_, kind, a) => `[${kind}](${attr(a, 'src') ?? ''})`)
      .replace(/<unknown\b([^>]*)\/>/g, (_, a) =>
        `[${attr(a, 'alt') || 'Open in Notion'}](${attr(a, 'url') ?? ''})`)
      .replace(/<span underline="true">([\s\S]*?)<\/span>/g, '<u>$1</u>')
      .replace(/<span\b[^>]*>([\s\S]*?)<\/span>/g, '$1')
      .replace(/<\/?(columns|column|synced_block|synced_block_reference)\b[^>]*>/g, '\n')
      .replace(/<(table_of_contents|empty-block)\b[^>]*\/>/g, '')
      .replace(/\s*\{(?:\s*[a-z-]+="[^"]*")+\s*\}\s*$/, ''); // block attrs like {color="blue"}

  const out = [];
  let fence = null; // { marker, indent } while inside a ``` block
  let pendingIcon = null;
  for (const raw of md.split('\n')) {
    const fenceMatch = raw.match(/^(\t*)(```+|~~~+)/);
    if (fence) {
      // drop only the block's own nesting tabs; keep the code's indentation
      out.push(raw.startsWith(fence.indent) ? raw.slice(fence.indent.length) : raw.trimStart());
      if (fenceMatch && fenceMatch[2][0] === fence.marker[0] && fenceMatch[2].length >= fence.marker.length) fence = null;
      continue;
    }
    if (fenceMatch) {
      fence = { indent: fenceMatch[1], marker: fenceMatch[2] };
      out.push(raw.slice(fence.indent.length));
      continue;
    }

    // Keep tab nesting for list items; strip it elsewhere (tab-indented text
    // would otherwise become a CommonMark indented code block).
    let line = LIST_ITEM.test(raw) ? raw : raw.replace(/^[\t ]+/, '');

    // Block-level tags → blank-line-separated HTML so markdown inside still parses.
    const callout = line.match(/^<callout\b([^>]*)>\s*(.*)$/);
    if (callout) {
      out.push('', '<blockquote>', '');
      pendingIcon = attr(callout[1], 'icon') ?? null;
      line = callout[2];
      if (!line) continue;
    }
    if (/^<\/callout>\s*$/.test(line)) {
      out.push('', '</blockquote>', '');
      continue;
    }
    if (/^<details\b[^>]*>\s*$/.test(line) || /^<\/details>\s*$/.test(line)) {
      out.push('');
      continue;
    }
    line = line.replace(/^<summary>([\s\S]*?)<\/summary>\s*$/, '**$1**');
    // Tables are already HTML: strip Notion attributes, keep the block contiguous,
    // and fence it with blank lines so the following markdown still parses.
    if (/^<table\b/.test(line)) out.push('');
    line = line.replace(/^<table\b[^>]*>/, '<table>').replace(/<colgroup>[\s\S]*?<\/colgroup>/g, '')
      .replace(/<(tr|td|th)\b[^>]*>/g, '<$1>');
    if (!line.trim() && raw.includes('<colgroup')) continue;
    if (/<\/table>\s*$/.test(line)) {
      out.push(inline(line), '');
      continue;
    }

    line = inline(line);
    if (pendingIcon && line.trim()) {
      line = `${pendingIcon} ${line}`;
      pendingIcon = null;
    }
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

// ---------- images: inline as data: URIs (Notion file URLs expire after ~1h) ----------
async function embedImages(html) {
  if (!EMBED_IMAGES) return html;
  const urls = [...new Set([...html.matchAll(/<img[^>]+src="(https?:[^"]+)"/g)].map((m) => m[1]))];
  for (const url of urls) {
    try {
      const real = url.replace(/&amp;/g, '&');
      const res = await fetch(real);
      const type = res.headers.get('content-type') ?? '';
      if (!res.ok || !type.startsWith('image/')) throw new Error(`${res.status} ${type}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_IMAGE_BYTES) throw new Error(`${buf.length} bytes, over limit`);
      html = html.split(`src="${url}"`).join(`src="data:${type};base64,${buf.toString('base64')}"`);
    } catch (e) {
      debug(`image skipped (${e.message}): ${url.slice(0, 80)}…`);
    }
  }
  return html;
}

export function buildHtml({ title, url, markdown, truncated }) {
  const body = marked.parse(notionToCommonMark(markdown), { gfm: true, breaks: true, async: false });
  const footer =
    `<p><small>${truncated ? '⚠️ Truncated — see the full page in Notion. ' : ''}` +
    `Synced from <a href="${esc(url)}">Notion</a> ${new Date().toLocaleString()}</small></p>`;
  return `<h1>${esc(title)}</h1>\n${body}\n<hr>\n${footer}`;
}

// ---------- Apple Notes (JXA) ----------
async function upsertNote(job) {
  const dir = await mkdtemp(join(tmpdir(), 'notion-notes-'));
  const jobPath = join(dir, 'job.json');
  try {
    await writeFile(jobPath, JSON.stringify(job));
    const { stdout } = await run('osascript', ['-l', 'JavaScript', join(HERE, 'notes-upsert.js'), jobPath], {
      maxBuffer: 1024 * 1024,
    });
    return stdout.trim();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------- state ----------
async function loadState() {
  try {
    return JSON.parse(await readFile(STATE_FILE, 'utf8'));
  } catch {
    return { pages: {} };
  }
}
async function saveState(state) {
  await mkdir(dirname(STATE_FILE), { recursive: true });
  const tmp = `${STATE_FILE}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2));
  await rename(tmp, STATE_FILE);
}

// ---------- main ----------
export async function sync({ dryRun = false, force = false, verbose = false } = {}) {
  VERBOSE = verbose;
  const state = await loadState();
  const seen = new Set();
  let updated = 0, skipped = 0, failed = 0;

  for await (const page of allSharedPages()) {
    if (page.in_trash || page.archived) continue;
    seen.add(page.id);
    const title = titleOf(page);
    const prev = state.pages[page.id];
    if (!force && prev?.noteId && prev.lastEdited === page.last_edited_time) {
      skipped++;
      continue;
    }
    try {
      const md = await notion(`/pages/${page.id}/markdown`);
      if (md.truncated) log(`warn: "${title}" truncated (${md.unknown_block_ids?.length ?? 0} blocks omitted)`);
      const html = await embedImages(buildHtml({ title, url: page.url, markdown: md.markdown, truncated: md.truncated }));
      if (dryRun) {
        log(`would ${prev?.noteId ? 'update' : 'create'}: ${title} (${html.length} bytes)`);
        updated++;
        continue;
      }
      const noteId = await upsertNote({ account: ACCOUNT, folder: FOLDER, noteId: prev?.noteId ?? null, html });
      state.pages[page.id] = { noteId, lastEdited: page.last_edited_time, title };
      await saveState(state);
      log(`${prev?.noteId ? 'updated' : 'created'}: ${title}`);
      updated++;
    } catch (e) {
      failed++;
      log(`error: "${title}": ${e.message}`);
    }
  }

  const gone = Object.entries(state.pages).filter(([id]) => !seen.has(id));
  for (const [, p] of gone) log(`note: "${p.title}" is no longer shared with the integration (left in Notes)`);
  log(`done: ${updated} ${dryRun ? 'to sync' : 'synced'}, ${skipped} unchanged, ${failed} failed`);
  if (failed) process.exitCode = 1;
}
