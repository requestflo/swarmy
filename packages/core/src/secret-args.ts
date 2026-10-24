import { looksSecret } from './dotenv';

/**
 * Secret-looking values in a process argv — `ContainerSpec.Args` / `Command`,
 * a healthcheck's `Test`. The env heuristic (`looksSecret`) only sees
 * `KEY=value`; credentials also travel as flags:
 *
 *   redis-server --requirepass hunter2      mongod --password=x
 *   redis-cli -a hunter2 ping               mysqladmin -phunter2 ping
 *   sh -c "redis-server --masterauth pw"    (words inside a shell string)
 *
 * Pure. Only the value is masked: flag names, paths and `$VAR` references
 * (the secret isn't inline there) stay readable.
 */

/** Flag names the env heuristic misses: redis' `requirepass` / `masterauth`, `--dbpass`. */
const EXTRA_FLAG = /(PASS$|MASTERAUTH)/;
const LONG_FLAG = /^--?[A-Za-z][\w.-]*$/;
const FLAG_EQ = /^(--?[A-Za-z][\w.-]*)=(.+)$/;
const ASSIGN = /^([A-Za-z_][\w.]*)=(.+)$/;
const REDIS_CLI = /(^|\/)(redis|valkey|keydb)-cli$/;
const MYSQL = /(^|\/)(mysql|mysqladmin|mysqldump|mariadb|mariadb-admin|mariadb-dump)$/;

/** `--requirepass` → `REQUIREPASS`; `-Dkeystore.password` → `DKEYSTORE_PASSWORD`. */
function flagLooksSecret(flag: string): boolean {
  const norm = flag.replace(/^-+/, '').replace(/[-.]/g, '_').toUpperCase();
  return looksSecret(norm) || EXTRA_FLAG.test(norm);
}

/** Not an inline value: `$PW`, `${PW}`, `$(cat /run/secrets/pw)`, or a file path. */
const kept = (v: string) => v.startsWith('$') || /^\/[\w./-]+$/.test(v);

/**
 * Per word: the replacement, or null to keep it. `words` are already unquoted.
 * Exported for tests; use {@link redactArgs}.
 */
export function maskWords(words: readonly string[], mask: string): (string | null)[] {
  const out: (string | null)[] = words.map(() => null);
  let redisCli = false;
  let mysql = false;
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    const next = words[i + 1];
    redisCli ||= REDIS_CLI.test(w);
    mysql ||= MYSQL.test(w);
    const eq = FLAG_EQ.exec(w);
    const assign = ASSIGN.exec(w);
    if (eq) {
      if (flagLooksSecret(eq[1]!) && !kept(eq[2]!)) out[i] = `${eq[1]}=${mask}`;
    } else if (mysql && /^-p\S/.test(w)) {
      if (!kept(w.slice(2))) out[i] = `-p${mask}`;
    } else if (LONG_FLAG.test(w)) {
      const secretFlag = flagLooksSecret(w) || (w === '-a' && redisCli);
      if (secretFlag && next !== undefined && !next.startsWith('-')) {
        if (!kept(next)) out[i + 1] = mask;
        i++;
      }
    } else if (assign) {
      if (looksSecret(assign[1]!, assign[2]!) && !kept(assign[2]!)) out[i] = `${assign[1]}=${mask}`;
    } else if (looksSecret('', w)) {
      out[i] = mask;
    }
  }
  return out;
}

/** Shell-ish words: runs of unquoted chars and quoted strings (`--pw="a b"` is one word). */
const WORD = /(?:[^\s"']+|"[^"]*"|'[^']*')+/g;
const unquote = (s: string) => s.replace(/["']/g, '');

/** Mask secret-looking words inside one shell string (`sh -c "…"`, `CMD-SHELL` tests). */
export function redactShellString(text: string, mask: string): string {
  const spans = [...text.matchAll(WORD)].map((m) => ({ start: m.index ?? 0, raw: m[0] }));
  const repl = maskWords(spans.map((s) => unquote(s.raw)), mask);
  let out = '';
  let at = 0;
  spans.forEach((s, i) => {
    const r = repl[i];
    out += text.slice(at, s.start) + (r ?? s.raw);
    at = s.start + s.raw.length;
  });
  return out + text.slice(at);
}

/**
 * Mask an argv. Each element is one word, except elements with whitespace
 * (a `sh -c` script, a `CMD-SHELL` healthcheck), which are judged word by word.
 */
export function redactArgs(args: readonly string[], mask: string): string[] {
  const spaced = (a: string) => /\s/.test(a);
  // A spaced element still counts as one word (the value after a flag);
  // a placeholder keeps it from being judged as a flag itself.
  const repl = maskWords(args.map((a) => (spaced(a) && !a.startsWith('$') ? '_' : a)), mask);
  return args.map((a, i) => repl[i] ?? (spaced(a) ? redactShellString(a, mask) : a));
}
