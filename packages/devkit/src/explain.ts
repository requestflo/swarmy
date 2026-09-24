/**
 * `explain_error` — turn a raw failure (a Swarm task error, a build log tail,
 * an API problem, a crash line) into what went wrong and what to do next.
 *
 * Pure pattern knowledge, no network: the MCP tool feeds it the service's
 * last task error and log tail, the CLI feeds it a pasted message. Ordered
 * most-specific first; every match contributes, so a log with an OOM kill and
 * a failed health check explains both.
 */

export interface ErrorExplanation {
  /** Stable id of the matched pattern (`oom-killed`). */
  id: string;
  title: string;
  /** What it means, in plain words. */
  cause: string;
  /** What to do, most likely fix first. */
  fixes: string[];
  /** The text that matched, trimmed. */
  evidence: string;
}

interface Pattern {
  id: string;
  re: RegExp;
  title: string;
  cause: string;
  fixes: string[];
}

const PATTERNS: Pattern[] = [
  {
    id: 'oom-killed',
    re: /OOMKilled|out of memory|exit(?:ed)?(?: with)?(?: code| status)? 137|non-zero exit \(137\)|JavaScript heap out of memory/i,
    title: 'Killed for using too much memory',
    cause: 'The container went over its memory limit and the kernel killed it (exit 137).',
    fixes: [
      'Raise the limit: set `memory:` (or a bigger `size:`) on the service in swarmy.yaml.',
      'For Node, cap the heap below the limit: NODE_OPTIONS=--max-old-space-size=<MB, ~75% of the limit>.',
      'Look for a leak or an unbounded cache if memory climbs steadily in the metrics.',
    ],
  },
  {
    id: 'exec-format',
    re: /exec format error/i,
    title: 'Image built for a different CPU',
    cause: 'The image is for another architecture (e.g. arm64 built on a Mac, running on an x86_64 node).',
    fixes: [
      'Let swarmy build it (build: in swarmy.yaml) so it builds on a node of the right architecture.',
      'Or publish a multi-arch image: docker buildx build --platform linux/amd64,linux/arm64 --push.',
    ],
  },
  {
    id: 'command-not-found',
    re: /exit(?:ed)?(?: with)?(?: code| status)? 127|non-zero exit \(127\)|executable file not found|command not found|no such file or directory.*(?:exec|entrypoint)/i,
    title: 'The start command does not exist in the image',
    cause: 'The container tried to run a program that is not in the image (exit 127).',
    fixes: [
      'Check `command:` in swarmy.yaml (or the Dockerfile CMD/ENTRYPOINT) for typos.',
      'Make sure the build copies the binary/script into the final stage of a multi-stage Dockerfile.',
    ],
  },
  {
    id: 'permission-denied-exec',
    re: /exit(?:ed)?(?: with)?(?: code| status)? 126|non-zero exit \(126\)|permission denied.*(?:exec|entrypoint|\.sh)/i,
    title: 'The start command is not executable',
    cause: 'The entrypoint exists but cannot be executed (exit 126).',
    fixes: ['chmod +x the script in the Dockerfile (RUN chmod +x /app/start.sh), or run it via `sh /app/start.sh`.'],
  },
  {
    id: 'image-auth',
    re: /pull access denied|unauthorized: authentication required|denied: requested access|no basic auth credentials|authentication required/i,
    title: 'The registry refused to hand over the image',
    cause: 'The image is private (or the name is wrong) and the node has no credentials for that registry.',
    fixes: [
      'Add the registry under Settings → Registry credentials (or POST /api/v1/registry-credentials).',
      'Check the image name and tag are spelled exactly as pushed.',
    ],
  },
  {
    id: 'image-not-found',
    re: /manifest unknown|manifest for .* not found|not found: manifest|repository does not exist|No such image/i,
    title: 'Image or tag not found',
    cause: 'The registry has no image with that name and tag.',
    fixes: ['Push the tag first, or fix the tag in swarmy.yaml / the compose file.', 'For private images, see registry credentials.'],
  },
  {
    id: 'rate-limit',
    re: /toomanyrequests|pull rate limit|rate limit exceeded/i,
    title: 'Docker Hub rate limit',
    cause: 'The node pulled too many images anonymously from Docker Hub.',
    fixes: [
      'Add Docker Hub credentials under registry credentials.',
      'Or mirror the image into the in-swarm registry and pull from there.',
    ],
  },
  {
    id: 'no-suitable-node',
    re: /no suitable node|insufficient resources|scheduling constraints|max replicas per node/i,
    title: 'No node can run this service',
    cause: 'Swarm found no node that satisfies the placement constraints, the CPU/memory reservation, or the image platform.',
    fixes: [
      'Lower `cpu:`/`memory:` or add capacity (swarmy nodes add).',
      'Check `regions:`/`placement.labels` in swarmy.yaml match real node labels (swarmy status shows nodes).',
      'An arm64-only or amd64-only image needs a node of that architecture.',
    ],
  },
  {
    id: 'port-in-use',
    re: /port is already allocated|address already in use|EADDRINUSE|bind: address/i,
    title: 'Port already taken',
    cause: 'Another service already publishes this port, or the app binds a port twice.',
    fixes: [
      'Do not publish host ports for web apps; give the service a `port:` and a domain, and swarmy routes to it.',
      'If a published port is needed, pick one no other service uses.',
    ],
  },
  {
    id: 'unhealthy',
    re: /unhealthy|health ?check (?:failed|timed out)|failed health/i,
    title: 'Health check failing',
    cause: 'The container runs, but its health check never passes, so Swarm keeps replacing it and deploys roll back.',
    fixes: [
      'Point `healthcheck.path` at a route that returns 200 without auth (e.g. /healthz).',
      'Make the app listen on 0.0.0.0 (not localhost) and on the `port:` in swarmy.yaml.',
      'Give slow starters time: healthcheck.start_period: 60s.',
    ],
  },
  {
    id: 'bind-localhost',
    re: /listening on (?:http:\/\/)?(?:localhost|127\.0\.0\.1)[:\s]/i,
    title: 'App only listens on localhost',
    cause: 'Inside a container, localhost is unreachable from the router — requests never arrive.',
    fixes: ['Bind to 0.0.0.0 (HOST=0.0.0.0, or `--host 0.0.0.0` / `-H 0.0.0.0` for most dev servers).'],
  },
  {
    id: 'connection-refused',
    re: /ECONNREFUSED|connection refused|could not connect to server/i,
    title: 'A dependency refused the connection',
    cause: 'The app reached the host but nothing listened there yet — usually a database still starting, or the wrong port.',
    fixes: [
      'Use the binding swarmy provides (DATABASE_URL: ${{ db.url }}) instead of a hard-coded host.',
      'Retry on startup: Swarm starts services in parallel and does not wait for dependencies.',
    ],
  },
  {
    id: 'dns',
    re: /ENOTFOUND|getaddrinfo|no such host|Name or service not known|could not translate host name/i,
    title: 'Host name does not resolve',
    cause: 'The name the app connects to does not exist on its networks.',
    fixes: [
      'Inside a stack, reach other services by their service name (`web`, `db`), or use the ${{ … }} bindings.',
      'Services in different apps need `connect:` in swarmy.yaml to share a network.',
    ],
  },
  {
    id: 'secret-missing',
    re: /secret .* not found|no such secret/i,
    title: 'Secret missing',
    cause: 'The service mounts a secret that does not exist.',
    fixes: ['Create it (swarmy env push --secret KEY, or Secrets in the dashboard) before deploying.'],
  },
  {
    id: 'mount-missing',
    re: /bind source path does not exist|invalid mount config/i,
    title: 'Mount source missing on the node',
    cause: 'A bind mount points at a host path that does not exist on the node the task landed on.',
    fixes: ['Use a named volume (volumes: { data: /data } in swarmy.yaml) instead of a host path.'],
  },
  {
    id: 'tls',
    re: /x509|certificate (?:has expired|signed by unknown|verify failed)|SSL routines/i,
    title: 'TLS certificate problem',
    cause: 'A TLS handshake failed: an expired, self-signed, or wrong-host certificate.',
    fixes: [
      'For a custom domain, check its DNS points at swarmy (swarmy status shows domain state).',
      'For outbound calls to an internal CA, add the CA to the image.',
    ],
  },
  {
    id: 'crash',
    re: /non-zero exit \((\d+)\)|exited with code [1-9]\d*|task: non-zero exit/i,
    title: 'The app crashed on start',
    cause: 'The process exited with an error soon after starting; Swarm restarts it and eventually rolls back.',
    fixes: [
      'Read the first error in the logs: swarmy logs <service> (or the logs tool).',
      'A missing env var is the usual cause — compare with swarmy env pull.',
    ],
  },
  {
    id: 'policy-denied',
    re: /POLICY_DENIED|lacks "write" scope|lacks "secrets\.read"|requires admin or owner|forbidden/i,
    title: 'Not allowed by policy',
    cause: 'The key or signed-in user is not permitted to do this (API key scope, role, or an org ABAC policy).',
    fixes: [
      'Read-only keys cannot change anything: swarmy login --scope write (an admin approves).',
      'An org policy may restrict this resource (e.g. production); ask an admin to check Governance → Policies.',
    ],
  },
  {
    id: 'no-manager',
    re: /NO_MANAGER|no online manager node|NODE_OFFLINE|node .* is offline/i,
    title: 'No manager node online',
    cause: 'swarmy needs an online Swarm manager to act, and none is connected right now.',
    fixes: ['Check the nodes (swarmy status); a node that went dark heals with the install one-liner in repair mode.'],
  },
  {
    id: 'timeout',
    re: /COMMAND_TIMEOUT|agent did not respond in time|context deadline exceeded/i,
    title: 'Timed out',
    cause: 'The node agent did not answer in time — it may be busy, overloaded, or losing connectivity.',
    fixes: ['Retry once; if it keeps happening, check the node’s load and network in the dashboard.'],
  },
  {
    id: 'yaml',
    re: /yaml\/|schema\/invalid|swarmy\.ya?ml/i,
    title: 'swarmy.yaml problem',
    cause: 'swarmy.yaml did not validate, so nothing was deployed.',
    fixes: ['Run swarmy check (or the check_repo tool) for every problem with its line number.'],
  },
];

/** Explain an error text. Empty when nothing matches (say so, then read the logs). */
export function explainError(text: string): ErrorExplanation[] {
  const out: ErrorExplanation[] = [];
  const seen = new Set<string>();
  for (const p of PATTERNS) {
    const m = p.re.exec(text);
    if (!m || seen.has(p.id)) continue;
    // A generic crash adds nothing when a specific exit reason already matched.
    if (p.id === 'crash' && out.some((e) => ['oom-killed', 'command-not-found', 'permission-denied-exec'].includes(e.id))) continue;
    seen.add(p.id);
    const start = text.lastIndexOf('\n', m.index) + 1;
    const end = text.indexOf('\n', m.index);
    out.push({
      id: p.id,
      title: p.title,
      cause: p.cause,
      fixes: p.fixes,
      evidence: text.slice(start, end < 0 ? undefined : end).trim().slice(0, 300),
    });
  }
  return out;
}

export function formatExplanations(list: ErrorExplanation[]): string {
  if (!list.length) {
    return 'No known pattern matched. Read the first error line in the logs (swarmy logs <service>) — the last line is usually a consequence, not the cause.';
  }
  return list
    .map((e) => [`${e.title}`, `  why: ${e.cause}`, ...e.fixes.map((f) => `  fix: ${f}`), `  seen: ${e.evidence}`].join('\n'))
    .join('\n\n');
}
