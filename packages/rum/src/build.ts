/**
 * Builds the two browser bundles the controller serves on `/_swarmy/*`:
 *   rum.js    — analytics + identified-mode plumbing (tiny, every page)
 *   replay.js — the rrweb recorder (sampled, consented sessions only)
 *
 * Built in-process with Bun.build on first request and memoised, so the
 * controller image ships no prebuilt artifact and the bundle can never drift
 * from the source. `bun run src/build.ts` writes them to dist/ (size check).
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export interface RumBundles {
  rum: string;
  replay: string;
  /** Short content hash (ETag). */
  etag: { rum: string; replay: string };
}

const here = dirname(fileURLToPath(import.meta.url));

async function bundle(entry: string): Promise<string> {
  const out = await Bun.build({
    entrypoints: [join(here, 'client', entry)],
    target: 'browser',
    format: 'iife',
    minify: true,
    sourcemap: 'none',
  });
  if (!out.success || !out.outputs[0]) {
    throw new Error(`rum bundle ${entry} failed: ${out.logs.map((l) => String(l)).join('; ')}`);
  }
  return out.outputs[0].text();
}

function hash(s: string): string {
  return new Bun.CryptoHasher('sha256').update(s).digest('hex').slice(0, 16);
}

let cached: Promise<RumBundles> | null = null;

export function rumBundles(): Promise<RumBundles> {
  if (!cached) {
    cached = Promise.all([bundle('rum.ts'), bundle('replay.ts')])
      .then(([rum, replay]) => ({ rum, replay, etag: { rum: hash(rum), replay: hash(replay) } }))
      .catch((e: unknown) => {
        cached = null;
        throw e;
      });
  }
  return cached;
}

if (import.meta.main) {
  const b = await rumBundles();
  const dist = join(here, '..', 'dist');
  await Bun.write(join(dist, 'rum.js'), b.rum);
  await Bun.write(join(dist, 'replay.js'), b.replay);
  const gz = (s: string) => Bun.gzipSync(Buffer.from(s)).length;
  console.log(`rum.js    ${b.rum.length} B (${gz(b.rum)} B gzip)`);
  console.log(`replay.js ${b.replay.length} B (${gz(b.replay)} B gzip)`);
}
