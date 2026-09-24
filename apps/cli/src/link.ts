/**
 * `swarmy link` state: `.swarmy/link.json` at the repo root, naming the
 * controller, app and (optionally) a default service/environment for this
 * checkout. No secrets — safe to keep, though `.swarmy/` is best gitignored.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface LinkFile {
  controller: string;
  repoId: string;
  app: string;
  environment?: string;
  service?: string;
}

export const LINK_DIR = '.swarmy';
export const LINK_FILE = 'link.json';

/** The nearest ancestor holding `.swarmy/link.json`, else the git root, else cwd. */
export async function findRoot(cwd = process.cwd()): Promise<{ root: string; linked: boolean }> {
  let dir = path.resolve(cwd);
  let gitRoot: string | null = null;
  for (;;) {
    if (await Bun.file(path.join(dir, LINK_DIR, LINK_FILE)).exists()) return { root: dir, linked: true };
    if (!gitRoot && (await Bun.file(path.join(dir, '.git', 'HEAD')).exists())) gitRoot = dir;
    const up = path.dirname(dir);
    if (up === dir) return { root: gitRoot ?? path.resolve(cwd), linked: false };
    dir = up;
  }
}

export async function readLink(cwd = process.cwd()): Promise<LinkFile | null> {
  const { root, linked } = await findRoot(cwd);
  if (!linked) return null;
  try {
    return JSON.parse(await readFile(path.join(root, LINK_DIR, LINK_FILE), 'utf8')) as LinkFile;
  } catch {
    return null;
  }
}

export async function writeLink(root: string, link: LinkFile): Promise<string> {
  await mkdir(path.join(root, LINK_DIR), { recursive: true });
  const file = path.join(root, LINK_DIR, LINK_FILE);
  await writeFile(file, `${JSON.stringify(link, null, 2)}\n`);
  // Keep the directory out of git without touching the user's .gitignore.
  await writeFile(path.join(root, LINK_DIR, '.gitignore'), '*\n');
  return file;
}

export async function removeLink(cwd = process.cwd()): Promise<boolean> {
  const { root, linked } = await findRoot(cwd);
  if (!linked) return false;
  await rm(path.join(root, LINK_DIR, LINK_FILE), { force: true });
  return true;
}

/** The checkout's `origin` remote URL and current branch, when it is a git repo. */
export async function gitInfo(cwd = process.cwd()): Promise<{ remote: string | null; branch: string | null }> {
  const run = async (args: string[]) => {
    try {
      const p = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'ignore' });
      const out = (await new Response(p.stdout).text()).trim();
      return (await p.exited) === 0 && out ? out : null;
    } catch {
      return null;
    }
  };
  const [remote, branch] = await Promise.all([run(['remote', 'get-url', 'origin']), run(['rev-parse', '--abbrev-ref', 'HEAD'])]);
  return { remote, branch: branch === 'HEAD' ? null : branch };
}
