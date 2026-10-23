/**
 * The folder tree on the git wizard, built from the `tree` that
 * `gitConnections.inspectSource` returns: the repo paths of its notable files
 * (swarmy.yaml, Dockerfile, compose, package.json, go.mod, …; see
 * NOTABLE_FILE_RE in git-providers/inspect.ts). Each folder is tagged with
 * what those file names say — never with what their contents would.
 */
export interface FolderRow {
  /** Repo-relative folder, '' for the root. */
  dir: string;
  /** Last segment + '/', or '/' for the root. */
  name: string;
  depth: number;
  tags: string[];
  /** Holds at least one notable file (a parent-only folder is a heading). */
  pickable: boolean;
  /** The swarmy.yaml this folder's app reads (existing name, else `swarmy.yaml`). */
  configPath: string;
  hasConfig: boolean;
}

const MANIFEST_TAG: Array<[string, string]> = [
  ['package.json', 'Node'],
  ['go.mod', 'Go'],
  ['requirements.txt', 'Python'],
  ['Gemfile', 'Ruby'],
  ['Cargo.toml', 'Rust'],
];

function tagsFor(files: Set<string>): string[] {
  const tags: string[] = [];
  if (files.has('swarmy.yaml') || files.has('swarmy.yml')) tags.push('swarmy.yaml');
  if (files.has('Dockerfile')) tags.push('Dockerfile');
  if ([...files].some((f) => /^(docker-)?compose\.ya?ml$/.test(f))) tags.push('compose');
  const lang = MANIFEST_TAG.find(([f]) => files.has(f));
  if (lang) tags.push(lang[1]);
  if (files.has('railpack.json')) tags.push('Railpack');
  return tags;
}

const dirOf = (p: string): string => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const baseOf = (p: string): string => p.slice(p.lastIndexOf('/') + 1);

/** Root first, then segment by segment, so every parent sits right above its children. */
function byPath(a: string, b: string): number {
  if (a === '' || b === '') return a === b ? 0 : a === '' ? -1 : 1;
  const x = a.split('/');
  const y = b.split('/');
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] !== y[i]) return x[i]! < y[i]! ? -1 : 1;
  }
  return x.length - y.length;
}

export function folderTree(tree: string[]): FolderRow[] {
  const byDir = new Map<string, Set<string>>();
  for (const p of tree) {
    const d = dirOf(p);
    byDir.set(d, (byDir.get(d) ?? new Set()).add(baseOf(p)));
  }
  const dirs = new Set<string>();
  for (const d of byDir.keys()) {
    dirs.add(d);
    // Parent folders become headings, so the tree reads as a tree.
    for (let i = d.indexOf('/'); i > 0; i = d.indexOf('/', i + 1)) dirs.add(d.slice(0, i));
  }
  return [...dirs]
    .sort(byPath)
    .map((dir) => {
      const files = byDir.get(dir) ?? new Set<string>();
      const yml = files.has('swarmy.yml') && !files.has('swarmy.yaml');
      const file = yml ? 'swarmy.yml' : 'swarmy.yaml';
      return {
        dir,
        name: dir === '' ? '/' : `${baseOf(dir)}/`,
        depth: dir === '' ? 0 : dir.split('/').length - 1,
        tags: tagsFor(files),
        pickable: files.size > 0,
        configPath: dir ? `${dir}/${file}` : file,
        hasConfig: files.has('swarmy.yaml') || files.has('swarmy.yml'),
      };
    });
}

/** More than one folder below the root holds an app (or the start of one). */
export function isMonorepo(rows: FolderRow[]): boolean {
  return rows.filter((r) => r.dir !== '' && r.pickable && r.tags.length > 0).length > 1;
}

/** The folder to start on: a swarmy.yaml not yet an app, then a Dockerfile, then the root. */
export function defaultFolder(rows: FolderRow[], taken: string[] = []): FolderRow | null {
  const free = rows.filter((r) => r.pickable && !taken.includes(r.configPath));
  return (
    free.find((r) => r.hasConfig) ??
    free.find((r) => r.tags.includes('Dockerfile')) ??
    free.find((r) => r.dir === '') ??
    free[0] ??
    null
  );
}
