/**
 * Where the CLI keeps its API key: the OS keychain when there is one (macOS
 * Keychain via `security`, the Secret Service via `secret-tool` on Linux),
 * otherwise `~/.config/swarmy/credentials.json` with mode 0600. The key is
 * passed to the keychain tools on stdin or as a single argv entry to a
 * process we spawn (never through a shell).
 *
 * Non-secret settings (the default controller, what the key may do) live in
 * `~/.config/swarmy/config.json`.
 *
 * `SWARMY_API_KEY` + `SWARMY_CONTROLLER` override everything (CI).
 */
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export const KEYCHAIN_SERVICE = 'swarmy-cli';

export interface CliConfig {
  controller?: string;
  /** Last known identity per controller (display only). */
  profiles?: Record<string, { email?: string | null; org?: string; scopes?: string[]; store?: CredentialStoreKind }>;
}

export type CredentialStoreKind = 'keychain' | 'secret-service' | 'file';

export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.SWARMY_CONFIG_DIR) return env.SWARMY_CONFIG_DIR;
  const base = env.XDG_CONFIG_HOME || path.join(homedir(), '.config');
  return path.join(base, 'swarmy');
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

/** Write a file only its owner can read, creating the directory 0700. */
export async function writePrivate(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, text, { mode: 0o600 });
  await chmod(file, 0o600); // an existing file keeps its old mode otherwise
}

export async function loadConfig(): Promise<CliConfig> {
  return readJson<CliConfig>(path.join(configDir(), 'config.json'), {});
}

export async function saveConfig(cfg: CliConfig): Promise<void> {
  await writePrivate(path.join(configDir(), 'config.json'), `${JSON.stringify(cfg, null, 2)}\n`);
}

/** Canonical controller key: origin, no trailing slash. */
export function controllerKey(url: string): string {
  try {
    const u = new URL(url);
    return u.origin;
  } catch {
    return url.replace(/\/+$/, '');
  }
}

// ── backends ─────────────────────────────────────────────────────────────────

interface Store {
  kind: CredentialStoreKind;
  get(account: string): Promise<string | null>;
  set(account: string, secret: string): Promise<void>;
  delete(account: string): Promise<void>;
}

async function exec(cmd: string[], stdin?: string): Promise<{ code: number; out: string }> {
  try {
    const p = Bun.spawn(cmd, { stdin: stdin === undefined ? 'ignore' : 'pipe', stdout: 'pipe', stderr: 'pipe' });
    if (stdin !== undefined && p.stdin) {
      p.stdin.write(stdin);
      await p.stdin.end();
    }
    const out = await new Response(p.stdout).text();
    return { code: await p.exited, out };
  } catch {
    return { code: 127, out: '' };
  }
}

const macKeychain: Store = {
  kind: 'keychain',
  async get(account) {
    const r = await exec(['security', 'find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account, '-w']);
    return r.code === 0 ? r.out.trim() || null : null;
  },
  async set(account, secret) {
    // `security -i` reads its command from stdin, so the key never appears in
    // argv (visible to `ps`). -U updates in place. Keys are base64url and the
    // account an URL origin, so double quotes are enough.
    if (!/^[A-Za-z0-9_-]+$/.test(secret) || /["\\\n]/.test(account)) throw new Error('refusing to store an unexpected credential format');
    const r = await exec(
      ['security', '-i'],
      `add-generic-password -U -s ${KEYCHAIN_SERVICE} -a "${account}" -l "swarmy CLI" -w "${secret}"\n`,
    );
    if (r.code !== 0 || !(await macKeychain.get(account))) throw new Error('could not write to the macOS keychain');
  },
  async delete(account) {
    await exec(['security', 'delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account]);
  },
};

const secretService: Store = {
  kind: 'secret-service',
  async get(account) {
    const r = await exec(['secret-tool', 'lookup', 'service', KEYCHAIN_SERVICE, 'account', account]);
    return r.code === 0 ? r.out.trim() || null : null;
  },
  async set(account, secret) {
    const r = await exec(['secret-tool', 'store', '--label', 'swarmy CLI', 'service', KEYCHAIN_SERVICE, 'account', account], secret);
    if (r.code !== 0) throw new Error('could not write to the Secret Service keyring');
  },
  async delete(account) {
    await exec(['secret-tool', 'clear', 'service', KEYCHAIN_SERVICE, 'account', account]);
  },
};

function fileStore(): Store {
  const file = path.join(configDir(), 'credentials.json');
  return {
    kind: 'file',
    async get(account) {
      const all = await readJson<Record<string, string>>(file, {});
      return all[account] ?? null;
    },
    async set(account, secret) {
      const all = await readJson<Record<string, string>>(file, {});
      all[account] = secret;
      await writePrivate(file, `${JSON.stringify(all, null, 2)}\n`);
    },
    async delete(account) {
      const all = await readJson<Record<string, string>>(file, {});
      if (!(account in all)) return;
      delete all[account];
      if (Object.keys(all).length) await writePrivate(file, `${JSON.stringify(all, null, 2)}\n`);
      else await rm(file, { force: true });
    },
  };
}

/** The best store on this machine. `SWARMY_CREDENTIAL_STORE=file` forces the file. */
export async function credentialStore(env: NodeJS.ProcessEnv = process.env): Promise<Store> {
  if (env.SWARMY_CREDENTIAL_STORE === 'file') return fileStore();
  if (process.platform === 'darwin' && Bun.which('security')) return macKeychain;
  if (process.platform === 'linux' && Bun.which('secret-tool') && (env.DBUS_SESSION_BUS_ADDRESS || env.DISPLAY || env.WAYLAND_DISPLAY)) {
    // Probe: a locked/absent keyring makes secret-tool fail — fall back then.
    const probe = await exec(['secret-tool', 'search', 'service', KEYCHAIN_SERVICE]);
    if (probe.code === 0 || probe.code === 1) return secretService;
  }
  return fileStore();
}

export interface Credential {
  controller: string;
  apiKey: string;
  source: 'env' | CredentialStoreKind;
}

/** The credential to use: env first, then the store for the chosen controller. */
export async function loadCredential(opts: { controller?: string } = {}): Promise<Credential | null> {
  const envKey = process.env.SWARMY_API_KEY;
  const cfg = await loadConfig();
  const controller = opts.controller ?? process.env.SWARMY_CONTROLLER ?? cfg.controller;
  if (envKey) {
    if (!controller) return null;
    return { controller: controllerKey(controller), apiKey: envKey, source: 'env' };
  }
  if (!controller) return null;
  const store = await credentialStore();
  const apiKey = await store.get(controllerKey(controller));
  if (apiKey) return { controller: controllerKey(controller), apiKey, source: store.kind };
  // A file-stored key from before a keychain appeared still counts.
  if (store.kind !== 'file') {
    const fromFile = await fileStore().get(controllerKey(controller));
    if (fromFile) return { controller: controllerKey(controller), apiKey: fromFile, source: 'file' };
  }
  return null;
}

export async function saveCredential(controller: string, apiKey: string): Promise<CredentialStoreKind> {
  const key = controllerKey(controller);
  let store = await credentialStore();
  try {
    await store.set(key, apiKey);
  } catch {
    store = fileStore();
    await store.set(key, apiKey);
  }
  return store.kind;
}

export async function deleteCredential(controller: string): Promise<void> {
  const key = controllerKey(controller);
  await (await credentialStore()).delete(key);
  await fileStore().delete(key);
}
