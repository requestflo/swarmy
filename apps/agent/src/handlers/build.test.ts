import { describe, expect, it } from 'bun:test';
import type { BuildImagePayload } from '@swarmy/core/protocol';
import {
  builderContainerOptions,
  parseBuildDigest,
  redact,
  renderBuildProgram,
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
  });

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
