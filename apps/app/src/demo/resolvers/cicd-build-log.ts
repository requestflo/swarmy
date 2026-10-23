/**
 * Demo build logs in BuildKit's `--progress=plain` shape — what the agent
 * really streams from `buildctl` — so the build page's layer list, warnings
 * filter and digest line all have something true-to-life to read. Cached-step
 * counts match the seeded builds' `cachedSteps` (Dockerfile 6, Railpack 14).
 */

export interface DemoLogLine {
  seq: number;
  stream: 'stdout' | 'stderr';
  message: string;
}

/**
 * Digests the demo registry-policy scans were taken of — the seeded builds of
 * these tags push exactly these digests, so a build page finds its scan.
 */
export const DEMO_SCANNED_DIGESTS: Record<string, string> = {
  'northwind-api:2.4.0': 'sha256:8f3c1a9be2d4706c5a1e0d9f4b83a52e91c7d64f0ab35e8c2917d40b6a5e21c3',
  'northwind-web:1.8.2': 'sha256:4b1d22e7a90cf34d8a6f5b02c7e19d3a85f60c41d92b7ae35c08e619f7d43b88',
};

type Step = [name: string, outcome: string, ...output: string[]];

const DOCKERFILE: Step[] = [
  ['[base 1/3] FROM docker.io/library/node:22-alpine@sha256:9f3c0b4e1d2a', 'CACHED'],
  ['[base 2/3] RUN apk add --no-cache tini', 'CACHED'],
  ['[base 3/3] WORKDIR /app', 'CACHED'],
  ['[deps 1/2] COPY package.json pnpm-lock.yaml ./', 'CACHED'],
  ['[deps 2/2] RUN pnpm install --frozen-lockfile', 'CACHED'],
  ['[build 1/3] COPY --from=deps /app/node_modules ./node_modules', 'CACHED'],
  ['[build 2/3] COPY . .', 'DONE 0.4s'],
  ['[build 3/3] RUN pnpm build', 'DONE 11.8s', '1.204 > tsc -p . && vite build', '9.870 (!) Some chunks are larger than 500 kB after minification.', '11.512 ✓ built in 10.31s'],
  ['[runtime 1/1] COPY --from=build /app/dist ./dist', 'DONE 0.6s'],
];

const RAILPACK: Step[] = [
  ['[packages:mise] mkdir -p /etc/mise', 'CACHED'],
  ['[packages:mise] create mise config', 'CACHED'],
  ['[packages:mise] mise install node pnpm', 'CACHED'],
  ['[install] copy package.json', 'CACHED'],
  ['[install] copy pnpm-lock.yaml', 'CACHED'],
  ['[install] copy pnpm-workspace.yaml', 'CACHED'],
  ['[install] pnpm install --frozen-lockfile', 'CACHED'],
  ['[build] copy tsconfig.json', 'CACHED'],
  ['[build] copy vite.config.ts', 'CACHED'],
  ['[build] copy index.html', 'CACHED'],
  ['[build] copy public', 'CACHED'],
  ['[build] copy packages/ui', 'CACHED'],
  ['[deploy] copy /etc/mise', 'CACHED'],
  ['[deploy] copy /root/.local/share/mise', 'CACHED'],
  ['[build] copy src', 'DONE 0.3s'],
  ['[build] pnpm run build', 'DONE 14.2s', '2.031 > vite build', '13.880 ✓ 412 modules transformed.'],
  ['[deploy] copy /app/dist', 'DONE 0.5s'],
];

const FAIL_AT = '[build 3/3] RUN pnpm build';

/** One build's log: clone, BuildKit steps, then push (or the failing step). */
export function makeBuildLog(image: string, ok: boolean, builder: 'dockerfile' | 'railpack'): { lines: DemoLogLine[] } {
  const out: string[] = [];
  let n = 1;
  const step = (name: string, ...rest: string[]): void => {
    out.push(`#${n} ${name}`, ...rest.map((r) => `#${n} ${r}`));
    n += 1;
  };
  step('[internal] load build definition from Dockerfile', 'transferring dockerfile: 512B done', 'DONE 0.0s');
  step('[internal] load metadata for docker.io/library/node:22-alpine', 'DONE 0.8s');
  step('[internal] load build context', 'transferring context: 1.31MB 0.1s done', 'DONE 0.1s');
  for (const [name, outcome, ...output] of builder === 'railpack' ? RAILPACK : DOCKERFILE) {
    if (!ok && name === FAIL_AT) {
      step(
        name,
        '1.204 > tsc -p . && vite build',
        "6.511 src/index.ts(42,7): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.",
        'ERROR: process "/bin/sh -c pnpm build" did not complete successfully: exit code: 2',
      );
      step('[runtime 1/1] COPY --from=build /app/dist ./dist', 'CANCELED');
      break;
    }
    step(name, ...output, outcome);
  }
  if (ok) {
    step('exporting to image', 'exporting layers 1.1s done', `pushing manifest for ${image} 0.2s done`, 'DONE 3.6s');
  }
  const lines: DemoLogLine[] = [{ seq: 0, stream: 'stdout', message: "Cloning into '/work/src'..." }];
  // buildctl writes its progress to stderr; the clone and summary go to stdout.
  out.forEach((message, i) => lines.push({ seq: i, stream: 'stderr', message }));
  lines.push({ seq: 1, stream: 'stdout', message: ok ? 'Build succeeded.' : 'Build failed: exit code 2' });
  return { lines };
}
