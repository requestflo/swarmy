import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

/**
 * The read-only view of a repository that `check` works over. Two
 * implementations: the local disk (the CLI, stdio MCP) and an in-memory file
 * map (the controller's HTTP MCP, where the caller sends the few files that
 * matter, and the tests). Paths are repo-relative with `/` separators.
 */
export interface RepoFs {
  /** File text, or null when absent (or a directory, or over `maxBytes`). */
  read(file: string): Promise<string | null>;
  exists(file: string): Promise<boolean>;
  /** Entry names directly inside `dir` ('' or '.' = the root). Empty when absent. */
  list(dir: string): Promise<string[]>;
}

/** Caps how much of any one file check reads (manifests are small). */
export const MAX_READ_BYTES = 512 * 1024;

/** Normalise a repo-relative path; null when it escapes the root. */
export function cleanRel(p: string): string | null {
  const parts: string[] = [];
  for (const seg of p.replace(/\\/g, '/').split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (!parts.length) return null;
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  return parts.join('/');
}

export function joinRel(dir: string, file: string): string {
  const d = cleanRel(dir) ?? '';
  return d ? `${d}/${file}` : file;
}

/** The local disk under `root`. Never follows a path out of the root. */
export function nodeRepoFs(root: string): RepoFs {
  const abs = (rel: string): string | null => {
    const r = cleanRel(rel);
    return r === null ? null : path.join(root, r);
  };
  return {
    async read(file) {
      const p = abs(file);
      if (!p) return null;
      try {
        const s = await stat(p);
        if (!s.isFile() || s.size > MAX_READ_BYTES) return null;
        return await readFile(p, 'utf8');
      } catch {
        return null;
      }
    },
    async exists(file) {
      const p = abs(file);
      if (!p) return false;
      try {
        await stat(p);
        return true;
      } catch {
        return false;
      }
    },
    async list(dir) {
      const p = abs(dir);
      if (!p) return [];
      try {
        return (await readdir(p)).sort();
      } catch {
        return [];
      }
    },
  };
}

/**
 * An in-memory repo from `{ "path/to/file": "text" }`. Directories are implied
 * by the file paths.
 */
export function memoryRepoFs(files: Record<string, string>): RepoFs {
  const map = new Map<string, string>();
  for (const [k, v] of Object.entries(files)) {
    const r = cleanRel(k);
    if (r) map.set(r, v);
  }
  const dirs = new Set<string>(['']);
  for (const k of map.keys()) {
    const segs = k.split('/');
    for (let i = 1; i < segs.length; i++) dirs.add(segs.slice(0, i).join('/'));
  }
  return {
    async read(file) {
      const r = cleanRel(file);
      return r === null ? null : (map.get(r) ?? null);
    },
    async exists(file) {
      const r = cleanRel(file);
      return r !== null && (map.has(r) || dirs.has(r));
    },
    async list(dir) {
      const d = cleanRel(dir);
      if (d === null) return [];
      const prefix = d ? `${d}/` : '';
      const out = new Set<string>();
      for (const k of [...map.keys(), ...dirs]) {
        if (!k || !k.startsWith(prefix) || k === d) continue;
        const rest = k.slice(prefix.length);
        if (rest) out.add(rest.split('/')[0]!);
      }
      return [...out].sort();
    },
  };
}
