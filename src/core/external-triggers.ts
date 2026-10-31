/**
 * Upkeep triggers outside the worktree (decision 0050).
 *
 * An upkeep `when:` normally names files of the worktree, listed by git. A
 * stack whose data comes from a sibling checkout (a data export in another
 * repository) needs that data's content in its template key, so a `when:` may
 * also reach outside:
 *
 * - `../other-repo/data/**` — relative to the stack root (the worktree);
 * - `/srv/exports/**` — absolute;
 * - `~/exports/**` — the daemon user's home;
 * - `{{main_worktree}}/../other-repo/data/**` — relative to the repository's
 *   MAIN worktree, which is the same directory for every linked worktree of
 *   the repository however deep it is nested (`.worktree/<name>`). This is
 *   the form to commit: `../` from a nested worktree points somewhere else.
 *
 * Such a glob is resolved to an absolute one; its files are listed by walking
 * the filesystem from the glob's literal directory — not git: the other tree
 * may be no repository, or another one — and matched, hashed and recorded
 * under their ABSOLUTE paths. A template key therefore depends on the content
 * and the resolved location, never on where the worktree sits, and a shared
 * template (decision 0044) stays shared.
 *
 * Bounds, so a typo cannot turn every `up` into a walk of the disk:
 * - the literal directory must not be `/`, and must not be the worktree or one
 *   of its ancestors (that walk would cover the worktree itself and every
 *   sibling) — name a directory beside or below it;
 * - `.git` and `node_modules` are never entered, directory symlinks are never
 *   followed;
 * - a walk that visits more than EXTERNAL_TRIGGER_MAX_ENTRIES entries fails
 *   the bind with a work-error naming the rule, instead of hashing a tree.
 * A literal directory that does not exist matches nothing (its rule's
 * fingerprint is that of no files, like a deleted trigger in the worktree).
 */
import { execFileSync } from 'node:child_process';
import { lstatSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { BrokerError, matchesAny } from './util.js';

/** Entries (files and directories) one external `when:` may visit. */
export const EXTERNAL_TRIGGER_MAX_ENTRIES = 20_000;
const YIELD_EVERY = 2000;
const MAIN_WORKTREE = /^\{\{\s*main_worktree\s*\}\}/;

const mainWorktrees = new Map<string, string>();

/**
 * The main worktree of the repository `root` belongs to: the parent of git's
 * common dir. `root` itself when it is no git checkout. Memoized per root.
 */
export function mainWorktreeOf(root: string): string {
  const hit = mainWorktrees.get(root);
  if (hit !== undefined) return hit;
  let main = root;
  try {
    const common = execFileSync('git', ['-C', root, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (common && common.endsWith(`${sep}.git`)) main = dirname(common);
  } catch {
    /* not a repository: the stack root stands for itself */
  }
  if (mainWorktrees.size > 256) mainWorktrees.clear();
  mainWorktrees.set(root, main);
  return main;
}

/** The glob of a `when:` with `glob(...)` and a leading `./` removed. */
const bare = (when: string): string => when.replace(/^glob\((.*)\)$/, '$1').replace(/^\.\//, '');

/**
 * The absolute glob a `when:` that reaches outside the worktree resolves to,
 * or null when it names worktree files (the git-listed, relative case).
 */
export function externalGlob(root: string, when: string): string | null {
  let p = bare(when);
  if (MAIN_WORKTREE.test(p)) p = mainWorktreeOf(root) + p.replace(MAIN_WORKTREE, '');
  else if (p === '~' || p.startsWith('~/')) p = homedir() + p.slice(1);
  else if (p.includes('{{')) throw new BrokerError('work-error', `upkeep when '${when}': only {{main_worktree}} may be templated, at its start`, 'manifest');
  if (!isAbsolute(p) && !normalize(p).split(/[\\/]/).includes('..')) return null;
  const abs = resolve(root, p);
  return sep === '/' ? abs : abs.split(sep).join('/');
}

/** The literal directory (or file) an absolute glob can only match under. */
function literalBase(glob: string): string {
  const parts = glob.split('/');
  const stop = parts.findIndex((seg) => /[*?[]/.test(seg));
  return (stop === -1 ? parts : parts.slice(0, stop)).join('/') || '/';
}

/** Refuse a walk that would cover the whole disk, the worktree or its siblings. */
function checkBase(root: string, when: string, base: string): void {
  const r = resolve(root);
  if (base === '/' || base === r || r.startsWith(base.endsWith('/') ? base : `${base}/`)) {
    throw new BrokerError(
      'work-error',
      `upkeep when '${when}' reaches outside the worktree from '${base}', which ${base === '/' ? 'is the filesystem root' : 'contains the worktree itself'} — name a directory beside or below the worktree (e.g. '{{main_worktree}}/../other-repo/data/**')`,
      'manifest',
    );
  }
}

/**
 * The files (absolute paths, with size and mtime) every external `when:` of
 * `whens` matches. Throws a work-error for an unsafe glob or one whose walk
 * exceeds the entry cap.
 */
export async function enumerateExternal(root: string, whens: string[], maxEntries = EXTERNAL_TRIGGER_MAX_ENTRIES): Promise<Array<{ path: string; size: number; mtimeMs: number }>> {
  const out = new Map<string, { path: string; size: number; mtimeMs: number }>();
  for (const when of whens) {
    const glob = externalGlob(root, when);
    if (glob === null) continue;
    const base = literalBase(glob);
    checkBase(root, when, base);
    let visited = 0;
    const visit = (): void => {
      if (++visited > maxEntries) {
        throw new BrokerError('work-error', `upkeep when '${when}' reaches outside the worktree and walked more than ${maxEntries} entries under '${base}' — narrow the glob to the files that define the data`, 'manifest');
      }
    };
    const walk = async (dir: string): Promise<void> => {
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        return;
      }
      for (const name of names.sort()) {
        if (name === '.git' || name === 'node_modules') continue;
        visit();
        if (visited % YIELD_EVERY === 0) await new Promise((r) => setImmediate(r));
        const full = join(dir, name);
        let st;
        try {
          st = lstatSync(full);
        } catch {
          continue; // vanished mid-walk
        }
        if (st.isDirectory()) await walk(full);
        else if (st.isFile() && matchesAny(full, [glob])) out.set(full, { path: full, size: st.size, mtimeMs: st.mtimeMs });
      }
    };
    let st;
    try {
      st = lstatSync(base);
    } catch {
      continue; // absent: matches nothing
    }
    if (st.isFile()) {
      if (matchesAny(base, [glob])) out.set(base, { path: base, size: st.size, mtimeMs: st.mtimeMs });
    } else if (st.isDirectory()) await walk(base);
  }
  return [...out.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** A trigger file's location: a worktree-relative path, or an external absolute one. */
export const triggerPath = (root: string, file: string): string => (isAbsolute(file) ? file : join(root, file));
