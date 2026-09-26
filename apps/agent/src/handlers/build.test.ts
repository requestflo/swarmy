import { describe, expect, it } from 'bun:test';
import type { BuildImagePayload } from '@swarmy/core/protocol';
import {
  builderContainerOptions,
  builderEnv,
  countCachedSteps,
  parseBuildDigest,
  parseBuildMeta,
  railpackEnvEntries,
  redact,
  renderBuildProgram,
  renderRailpackPrepareDockerfile,
  splitMetaLines,
  tailLines,
} from './build';

const DIGEST = 'sha256:' + 'ab'.repeat(32);

function payload(over: Partial<BuildImagePayload> = {}): BuildImagePayload {
  return {
    commandId: '11111111-2222-3333-4444-555555555555',
    source: { url: 'https://github.com/traefik/whoami', ref: 'master' },
    imageRefs: ['localhost:5000/whoami:master'],
    pushPolicy: 'always',
    ...over,
  } as BuildImagePayload;
}

describe('renderBuildProgram', () => {
  it('renders the hand-proven rootless pipeline (golden)', () => {
    expect(renderBuildProgram(payload())).toBe(
      [
        'set -e',
        'W="$HOME/workspace"',
        'export DOCKER_CONFIG="$HOME/.docker"',
        'rm -rf "$W" && mkdir -p "$W"',
        `git clone --depth 1 --branch 'master' 'https://github.com/traefik/whoami' "$W"`,
        ':',
        'rootlesskit buildkitd --oci-worker-no-process-sandbox >/tmp/buildkitd.log 2>&1 &',
        'ready=0',
        'for i in $(seq 1 30); do buildctl debug workers >/dev/null 2>&1 && ready=1 && break; sleep 1; done',
        'if [ "$ready" != 1 ]; then echo "buildkitd did not become ready within 30s" >&2; cat /tmp/buildkitd.log >&2; exit 1; fi',
        `buildctl build --frontend dockerfile.v0 --local context="$W"/'.' --local dockerfile="$W"/'.' --opt filename='Dockerfile' --output 'type=image,name=localhost:5000/whoami:master,push=true,registry.insecure=true' --metadata-file /tmp/meta.json`,
        `echo "SWARMY_DIGEST=$(tr -d '\\n' < /tmp/meta.json | sed -n 's/.*"containerimage.digest": *"\\([^"]*\\)".*/\\1/p')"`,
      ].join('\n'),
    );
  });

  it('never touches /workspace or /root (rootless uid 1000)', () => {
    const prog = renderBuildProgram(
      payload({ registryAuth: { username: 'u', password: 'p', server: 'localhost:5000' } }),
    );
    expect(prog).not.toContain('/root');
    expect(prog).not.toMatch(/(^|[\s=])\/workspace/);
    expect(prog).toContain('mkdir -p "$DOCKER_CONFIG" && printf %s');
    expect(prog).toContain('> "$DOCKER_CONFIG/config.json"');
    expect(prog).not.toContain('sleep 2');
  });

  it('renders subdir/dockerfile/target/build-args and no-push', () => {
    const prog = renderBuildProgram(
      payload({
        source: { url: 'https://x/y', ref: 'main', subdir: 'svc/api', dockerfile: 'Dockerfile.prod' },
        target: 'runtime',
        buildArgs: { A: "it's" },
        pushPolicy: 'never',
      }),
    );
    expect(prog).toContain(`--local context="$W"/'svc/api'`);
    expect(prog).toContain(`--opt filename='Dockerfile.prod'`);
    expect(prog).toContain(`--opt target='runtime'`);
    expect(prog).toContain(`--opt build-arg:A='it'\\''s'`);
    expect(prog).toContain('push=false,registry.insecure=true');
  });

  it('embeds the git token only in the clone URL', () => {
    const prog = renderBuildProgram(payload({ source: { url: 'https://github.com/o/r', ref: 'main', token: 'tok' } }));
    expect(prog).toContain('https://x-access-token:tok@github.com/o/r');
  });
});

describe('git-apps source options', () => {
  const SHA = 'c'.repeat(40);

  it('builds an exact sha instead of the branch tip', () => {
    const prog = renderBuildProgram(
      payload({ source: { url: 'https://github.com/o/r', ref: 'main', sha: SHA } }),
    );
    expect(prog).toContain(
      `git -C "$W" init -q && git -C "$W" remote add origin 'https://github.com/o/r' && git -C "$W" fetch -q --depth 1 origin '${SHA}' && git -C "$W" checkout -q FETCH_HEAD`,
    );
    expect(prog).not.toContain('git clone');
  });

  it('uses the provider token username (GitLab oauth2)', () => {
    const prog = renderBuildProgram(
      payload({
        source: { url: 'https://gitlab.com/o/r', ref: 'main', token: 'glt', tokenUser: 'oauth2' },
      }),
    );
    expect(prog).toContain('https://oauth2:glt@gitlab.com/o/r');
  });

  it('keeps a deploy key out of the program text — it rides the container env', () => {
    const key = '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----';
    const prog = renderBuildProgram(
      payload({ source: { url: 'git@github.com:o/r.git', ref: 'main', sshKey: key } }),
    );
    expect(prog).not.toContain('abc');
    expect(prog).toContain('"$SWARMY_SSH_KEY" > "$HOME/.ssh/id"');
    expect(prog).toContain('GIT_SSH_COMMAND=');
    const o = builderContainerOptions('n', 'img', prog, { SWARMY_SSH_KEY: key });
    expect(o.Env).toEqual([`SWARMY_SSH_KEY=${key}`]);
    expect(builderContainerOptions('n', 'img', 'true')).not.toHaveProperty('Env');
  });
});

describe('digest extraction', () => {
  it('shell sed pattern tolerates the space BuildKit writes after the colon', async () => {
    const sed = `s/.*"containerimage.digest": *"\\([^"]*\\)".*/\\1/p`;
    for (const meta of [
      `{\n  "containerimage.digest": "${DIGEST}",\n  "image.name": "x"\n}`,
      `{"containerimage.digest":"${DIGEST}"}`,
    ]) {
      const proc = Bun.spawn(['sh', '-c', `tr -d '\\n' | sed -n '${sed}'`], { stdin: 'pipe', stdout: 'pipe' });
      proc.stdin.write(meta);
      proc.stdin.end();
      expect((await new Response(proc.stdout).text()).trim()).toBe(DIGEST);
    }
  }, 30_000);

  it('parseBuildDigest reads the marker line', () => {
    expect(parseBuildDigest(`#12 done\nSWARMY_DIGEST=${DIGEST}\n`)).toBe(DIGEST);
  });

  it('parseBuildDigest falls back to a spaced metadata blob', () => {
    expect(parseBuildDigest(`{ "containerimage.digest" :  "${DIGEST}" }`)).toBe(DIGEST);
    expect(parseBuildDigest(`{"containerimage.digest":"${DIGEST}"}`)).toBe(DIGEST);
  });

  it('parseBuildDigest returns null for an empty marker', () => {
    expect(parseBuildDigest('SWARMY_DIGEST=\n')).toBeNull();
  });
});

describe('builderContainerOptions', () => {
  it('runs on the host network so localhost:5000 is the routing-mesh registry', () => {
    const o = builderContainerOptions('swarmy-build-x', 'moby/buildkit:rootless', 'true');
    expect(o.HostConfig.NetworkMode).toBe('host');
    expect(o.HostConfig.Privileged).toBe(false);
    expect(o.HostConfig.SecurityOpt).toEqual(['seccomp=unconfined', 'apparmor=unconfined']);
    expect(o.Entrypoint).toEqual(['sh', '-c']);
    expect(o.Cmd).toEqual(['true']);
  });
});

describe('error context', () => {
  it('tailLines keeps the last non-empty lines', () => {
    expect(tailLines('a\n\nb\r\nc\n', 2)).toEqual(['b', 'c']);
  });

  it('redact masks secrets', () => {
    expect(redact('https://x-access-token:ghp_s3cr3t@h/r failed ghp_s3cr3t', ['ghp_s3cr3t'])).toBe(
      'https://x-access-token:***@h/r failed ***',
    );
  });
});

describe('Railpack (zero-config) builds', () => {
  const rp = (over: Partial<BuildImagePayload> = {}) =>
    payload({
      source: { url: 'https://github.com/o/app', ref: 'main' },
      imageRefs: ['localhost:5000/app:main'],
      builder: 'railpack',
      railpack: { startCmd: 'node server.js', env: { API_URL: 'https://api.example.com' }, cacheKey: 'app' },
      cache: {
        importRefs: ['localhost:5000/app:buildcache-root-main'],
        exportRef: 'localhost:5000/app:buildcache-root-main',
        mode: 'max',
      },
      ...over,
    });

  it('renders prepare-in-BuildKit → pinned plan → gateway frontend + registry cache (golden)', () => {
    expect(renderBuildProgram(rp())).toBe(
      [
        "set -e",
        "W=\"$HOME/workspace\"",
        "export DOCKER_CONFIG=\"$HOME/.docker\"",
        "rm -rf \"$W\" && mkdir -p \"$W\"",
        "git clone --depth 1 --branch 'main' 'https://github.com/o/app' \"$W\"",
        ":",
        "mkdir -p \"$HOME/.config/buildkit\" && printf '%s\\n' '[registry.\"localhost:5000\"]",
        "  http = true",
        "  insecure = true' > \"$HOME/.config/buildkit/buildkitd.toml\"",
        "rootlesskit buildkitd --config \"$HOME/.config/buildkit/buildkitd.toml\" --oci-worker-no-process-sandbox >/tmp/buildkitd.log 2>&1 &",
        "ready=0",
        "for i in $(seq 1 30); do buildctl debug workers >/dev/null 2>&1 && ready=1 && break; sleep 1; done",
        "if [ \"$ready\" != 1 ]; then echo \"buildkitd did not become ready within 30s\" >&2; cat /tmp/buildkitd.log >&2; exit 1; fi",
        "echo \"SWARMY_META builder railpack\"",
        "RP=\"$HOME/railpack\"",
        "rm -rf \"$RP\" && mkdir -p \"$RP/prep\" \"$RP/out\" \"$RP/plan\"",
        "rm -rf \"$W/.git\"",
        "printf '%s\\n' 'FROM ghcr.io/railwayapp/railpack-frontend@sha256:fc6d5fa434c9310500dc18bebb0a4eb4854fee8546a6d7a090e7a36e39d9d153 AS rp' 'FROM docker.io/library/bash@sha256:a54fb4422b18f05dd3107c36f39d67b26334fda7ec89f4126052b45e228e2f15 AS prep' 'COPY --from=rp /railpack /usr/local/bin/railpack' 'COPY prepare.sh /swarmy-prepare.sh' 'RUN --mount=type=bind,from=app,target=/app --mount=type=secret,id=SWARMY_BENV_0 sh /swarmy-prepare.sh' 'FROM scratch' 'COPY --from=prep /out /' > \"$RP/prep/Dockerfile\"",
        "printf '%s\\n' 'set -u' 'mkdir -p /out' 'n=0' 'while :; do rc=0; railpack prepare /app --plan-out /out/railpack-plan.json --info-out /out/info.json --start-cmd '\\''node server.js'\\'' --env \"API_URL=$(cat /run/secrets/SWARMY_BENV_0)\" >>/out/prepare.log 2>&1 || rc=$?; if [ \"$rc\" = 75 ] && [ \"$n\" -lt 3 ]; then n=$((n+1)); echo \"railpack prepare hit a transient error, retrying ($n/3)\" >>/out/prepare.log; sleep 3; continue; fi; break; done' 'echo \"$rc\" > /out/rc' > \"$RP/prep/prepare.sh\"",
        "echo \"Railpack: planning the build (railpack prepare)\"",
        "if ! buildctl build --frontend dockerfile.v0 --local context=\"$RP/prep\" --local dockerfile=\"$RP/prep\" --local app=\"$W\"/'.' --opt context:app=local:app --secret id=SWARMY_BENV_0,env=SWARMY_BENV_0 --output type=local,dest=\"$RP/out\" >\"$RP/prep.log\" 2>&1; then cat \"$RP/prep.log\" >&2; echo \"could not run railpack prepare in BuildKit\" >&2; exit 1; fi",
        "cat \"$RP/out/prepare.log\" 2>/dev/null || true",
        "rc=$(cat \"$RP/out/rc\" 2>/dev/null || echo 1)",
        "if [ -f \"$RP/out/info.json\" ]; then echo \"SWARMY_META railpack-info $(base64 < \"$RP/out/info.json\" | tr -d '\\n')\"; fi",
        "if [ \"$rc\" != 0 ]; then echo \"Railpack could not plan this app (railpack prepare exited $rc). Add a Dockerfile, or set build.start in swarmy.yaml.\" >&2; exit 1; fi",
        "mv \"$RP/out/railpack-plan.json\" \"$RP/plan/railpack-plan.json\"",
        "sed -i -e 's#\"ghcr\\.io/railwayapp/railpack-builder:mise-2026\\.9\\.12\"#\"ghcr.io/railwayapp/railpack-builder@sha256:a104c45734b7c59fa7f52ab5afac87c3a4dfa5ee1c5495ae0c798756c670c865\"#g' -e 's#\"ghcr\\.io/railwayapp/railpack-runtime:mise-2026\\.9\\.12\"#\"ghcr.io/railwayapp/railpack-runtime@sha256:b699280f7b492ddba483ee1d03badaae238b8846ff2ef1e71ad8a2fd637c25b5\"#g' \"$RP/plan/railpack-plan.json\"",
        "echo \"SWARMY_META railpack-plan $(base64 < \"$RP/plan/railpack-plan.json\" | tr -d '\\n')\"",
        "SH=$( { printf '%s=%s\\n' 'API_URL' \"$SWARMY_BENV_0\"; } | sha256sum | cut -d' ' -f1)",
        "buildctl build --frontend gateway.v0 --opt source='ghcr.io/railwayapp/railpack-frontend@sha256:fc6d5fa434c9310500dc18bebb0a4eb4854fee8546a6d7a090e7a36e39d9d153' --local context=\"$W\"/'.' --local dockerfile=\"$RP/plan\" --opt build-arg:cache-key='app' --opt build-arg:secrets-hash=\"$SH\" --secret id=API_URL,env=SWARMY_BENV_0 --import-cache 'type=registry,ref=localhost:5000/app:buildcache-root-main' --export-cache 'type=registry,ref=localhost:5000/app:buildcache-root-main,mode=max,ignore-error=true' --output 'type=image,name=localhost:5000/app:main,push=true,registry.insecure=true' --metadata-file /tmp/meta.json",
        "echo \"SWARMY_DIGEST=$(tr -d '\\n' < /tmp/meta.json | sed -n 's/.*\"containerimage.digest\": *\"\\([^\"]*\\)\".*/\\1/p')\"",
      ].join('\n'),
    );
  });

  it('keeps build-env VALUES out of the program text (container env + BuildKit secrets only)', () => {
    const p = rp();
    const prog = renderBuildProgram(p);
    expect(prog).not.toContain('https://api.example.com');
    expect(builderEnv(p)).toEqual({ SWARMY_BENV_0: 'https://api.example.com' });
    expect(prog).toContain('--secret id=API_URL,env=SWARMY_BENV_0');
  });

  it('auto: the Dockerfile wins when present, else Railpack', () => {
    const prog = renderBuildProgram(rp({ builder: 'auto', source: { url: 'https://x/y', ref: 'main', subdir: 'web' } }));
    expect(prog).toContain(`if [ -f "$W"/'web'/'Dockerfile' ]; then B=dockerfile; else B=railpack;`);
    expect(prog).toContain('echo "SWARMY_META builder $B"');
    expect(prog).toContain('--frontend dockerfile.v0 --local context="$W"/\'web\'');
    expect(prog).toContain('--frontend gateway.v0');
    // both paths carry the cache flags
    expect(prog.match(/--import-cache/g)?.length).toBe(2);
  });

  it('explicit dockerfile keeps the Dockerfile line and adds the registry cache', () => {
    const prog = renderBuildProgram(rp({ builder: 'dockerfile' }));
    expect(prog).not.toContain('railpack prepare');
    expect(prog).toContain(
              `--import-cache 'type=registry,ref=localhost:5000/app:buildcache-root-main' --export-cache 'type=registry,ref=localhost:5000/app:buildcache-root-main,mode=max,ignore-error=true'`,
    );
    expect(prog).toContain('--config "$HOME/.config/buildkit/buildkitd.toml"');
  });

  it('maps swarmy.yaml overrides onto Railpack config env (apt lists are additive)', () => {
    expect(
      railpackEnvEntries({
        installCmd: 'npm ci',
        packages: ['node@22', 'jq@latest'],
        buildAptPackages: ['build-essential'],
        deployAptPackages: ['ffmpeg'],
        env: { Z: '1', A: '2', RAILPACK_PACKAGES: 'ignored' },
      }),
    ).toEqual([
      ['RAILPACK_INSTALL_CMD', 'npm ci'],
      ['RAILPACK_PACKAGES', 'node@22 jq@latest'],
      ['RAILPACK_BUILD_APT_PACKAGES', '... build-essential'],
      ['RAILPACK_DEPLOY_APT_PACKAGES', '... ffmpeg'],
      ['A', '2'],
      ['Z', '1'],
    ]);
  });

  it('prepare runs on mirrored images when the controller rewrites them', () => {
    const df = renderRailpackPrepareDockerfile(
      rp({
        railpack: {
          frontendImage: 'localhost:5000/swarmy-system/ghcr.io/railwayapp/railpack-frontend@sha256:f',
          prepareImage: 'localhost:5000/swarmy-system/docker.io/library/bash@sha256:b',
        },
      }),
    );
    expect(df.split('\n').slice(0, 2)).toEqual([
      'FROM localhost:5000/swarmy-system/ghcr.io/railwayapp/railpack-frontend@sha256:f AS rp',
      'FROM localhost:5000/swarmy-system/docker.io/library/bash@sha256:b AS prep',
    ]);
  });

  it('the plan rewrite sed matches the exact quoted ref (real sed)', async () => {
    const prog = renderBuildProgram(rp());
    const sedLine = prog.split('\n').find((l) => l.startsWith('sed -i'))!;
    const plan = JSON.stringify({ steps: [{ inputs: [{ image: 'ghcr.io/railwayapp/railpack-builder:mise-2026.9.12' }] }], deploy: { base: { image: 'ghcr.io/railwayapp/railpack-runtime:mise-2026.9.12' } } });
    const dir = `${process.env.TMPDIR ?? '/tmp'}/swarmy-sed-${process.pid}`;
    const script = `mkdir -p ${dir}/plan && printf %s '${plan}' > ${dir}/plan/railpack-plan.json && RP=${dir} && ${sedLine.replace('sed -i', 'sed -i.bak')} && cat ${dir}/plan/railpack-plan.json; rm -rf ${dir}`;
    const proc = Bun.spawn(['sh', '-c', script], { stdout: 'pipe', stderr: 'pipe' });
    const out = await new Response(proc.stdout).text();
    expect(out).toContain('"ghcr.io/railwayapp/railpack-builder@sha256:a104c457');
    expect(out).toContain('"ghcr.io/railwayapp/railpack-runtime@sha256:b699280f');
    expect(out).not.toContain('mise-2026.9.12');
  }, 30_000);
});

describe('build meta capture', () => {
  it('pulls SWARMY_META lines out of the log across chunk boundaries', () => {
    const a = splitMetaLines('', '#1 step\nSWARMY_META build');
    expect(a).toEqual({ forward: '#1 step\n', metas: [], carry: 'SWARMY_META build' });
    const b = splitMetaLines(a.carry, 'er railpack\n#2 next\n');
    expect(b).toEqual({ forward: '#2 next\n', metas: ['builder railpack'], carry: '' });
  });

  it('decodes Railpack info + plan into the build result', () => {
    const info = Buffer.from(
      JSON.stringify({
        railpackVersion: '0.40.0',
        detectedProviders: ['node'],
        resolvedPackages: { node: { resolvedVersion: '22.23.2' } },
        metadata: { nodePackageManager: 'npm' },
      }),
    ).toString('base64');
    const plan = Buffer.from(JSON.stringify({ deploy: { startCommand: 'npm run start' } })).toString('base64');
    expect(parseBuildMeta(['builder railpack', `railpack-info ${info}`, `railpack-plan ${plan}`])).toEqual({
      builder: 'railpack',
      railpack: {
        version: '0.40.0',
        providers: ['node'],
        packages: { node: '22.23.2' },
        metadata: { nodePackageManager: 'npm' },
        startCommand: 'npm run start',
      },
    });
    expect(parseBuildMeta(['builder dockerfile'])).toEqual({ builder: 'dockerfile' });
    expect(parseBuildMeta(['railpack-info not-base64-json'])).toEqual({});
  });

  it('counts cache hits but not base-image resolves', () => {
    const out = ['#2 docker-image://ghcr.io/x@sha256:1', '#2 CACHED', '#9 npm install', '#9 CACHED', '#10 copy / /app', '#10 DONE 0.1s'].join('\n');
    expect(countCachedSteps(out)).toBe(1);
  });
});
