import { createFileRoute, Link } from '@tanstack/react-router';
import {
  ActivityIcon,
  BotIcon,
  DatabaseIcon,
  GitBranchIcon,
  GlobeIcon,
  ShieldCheckIcon,
  WaypointsIcon,
  type LucideIcon,
} from 'lucide-react';
import { Button } from '@swarmy/ui/components/button';
import { ComingTag, MarketingLayout, PageIntro } from '@/components/marketing-layout';
import { seo } from '@/lib/seo';

export const Route = createFileRoute('/features')({
  head: () =>
    seo({
      title: 'Features',
      description:
        'What swarmy does today: git apps with swarmy.yaml, 69 templates, managed Postgres with backups, a geo-DNS edge, a WireGuard mesh, an AI gateway and observability. Plus what is coming.',
      path: '/features',
    }),
  component: Features,
});

interface Item {
  title: string;
  body: string;
  coming?: boolean;
}

interface Group {
  id: string;
  icon: LucideIcon;
  title: string;
  lead: string;
  docs: string;
  items: Item[];
}

const GROUPS: Group[] = [
  {
    id: 'deploy',
    icon: GitBranchIcon,
    title: 'Deploy from git',
    lead: 'A swarmy.yaml in the repo declares the app and everything it needs. A push is the deploy.',
    docs: 'guides/deploy-from-git',
    items: [
      {
        title: 'swarmy.yaml',
        body: 'Services, Postgres, caches, search, buckets, cron jobs, domains and environments in one file. Bindings like ${{ db.url }} wire them together.',
      },
      {
        title: 'Plans you can read',
        body: 'Every change is shown as a plan first. Destructive changes wait for a human; impossible ones are blocked.',
      },
      {
        title: 'GitHub, GitLab, Gitea and plain git',
        body: 'GitHub connects in one click through an app your instance owns. Others use OAuth, tokens or a deploy key.',
      },
      {
        title: 'Dockerfile builds',
        body: 'Rootless BuildKit on your builder nodes, with a warm cache, pushed to a registry inside your swarm.',
      },
      {
        title: 'Builds without a Dockerfile',
        body: 'Railpack detects the language and builds the image for you.',
        coming: true,
      },
      {
        title: 'Previews for every PR',
        body: 'Each pull request gets its own URL and its own throwaway database.',
      },
      {
        title: 'Safe releases',
        body: 'Health-gated deploys with automatic rollback, one-click rollback with a diff, canaries and scale-to-zero.',
      },
      {
        title: '69 one-click templates',
        body: 'Ghost, Plausible, Uptime Kuma, Immich, Nextcloud, Vaultwarden, Gitea, Open WebUI and more, plus WordPress and other blueprints wired to managed data.',
      },
      {
        title: 'Compose in, Compose out',
        body: 'Import a docker-compose file, and export any stack back to plain Compose without losing anything.',
      },
    ],
  },
  {
    id: 'data',
    icon: DatabaseIcon,
    title: 'Managed data',
    lead: 'Databases and storage that run on your nodes, with backups on by default.',
    docs: 'concepts/data',
    items: [
      {
        title: 'Managed Postgres',
        body: 'Single node, primary with replicas, automatic failover or multi-region. Pick a version; swarmy keeps it running.',
      },
      {
        title: 'Backups and point-in-time recovery',
        body: 'Encrypted, deduplicated restic backups to S3 or a node path, WAL archiving for PITR, and one-click restore.',
      },
      {
        title: 'Restore drills',
        body: 'Prove a backup restores before you need it. The resilience score tells you what is not covered yet.',
      },
      {
        title: 'Caches, search and vectors',
        body: 'Valkey or Redis, Meilisearch, and Qdrant or pgvector, attached to an app with one binding.',
      },
      {
        title: 'Object storage',
        body: 'S3-compatible buckets on your own nodes, replicated with Garage.',
      },
      {
        title: 'Database studio',
        body: 'Browse and edit data in the dashboard.',
        coming: true,
      },
    ],
  },
  {
    id: 'edge',
    icon: GlobeIcon,
    title: 'The edge',
    lead: 'Get traffic to your apps, over HTTPS, from the nearest region.',
    docs: 'concepts/edge',
    items: [
      {
        title: 'Automatic TLS',
        body: "Caddy on by default. Let's Encrypt for public names, a local CA for private ones.",
      },
      {
        title: 'A URL before you own a domain',
        body: 'Apps get an automatic address, so the first deploy is reachable straight away.',
      },
      {
        title: 'Authoritative geo-DNS',
        body: 'swarmy-dns runs on your edge nodes and answers with the closest healthy region.',
      },
      {
        title: 'Route protection',
        body: 'Rate limits, IP and country allow or deny lists, bot blocking and caching per route.',
      },
      {
        title: 'Tunnels',
        body: 'No public IP? Publish through a Cloudflare tunnel.',
      },
    ],
  },
  {
    id: 'mesh',
    icon: WaypointsIcon,
    title: 'Servers and mesh',
    lead: 'Any Linux box can be a node, wherever it is.',
    docs: 'concepts/mesh',
    items: [
      {
        title: 'Nodes dial out',
        body: 'The agent connects out to the controller over an authenticated WebSocket. No inbound ports, so NAT is fine.',
      },
      {
        title: 'WireGuard mesh',
        body: 'Join sites with NetBird, Headscale, Tailscale or plain WireGuard, and connect stacks across them.',
      },
      {
        title: 'Self-healing nodes',
        body: 'swarmy-agent doctor finds what is wrong and fixes the safe things. A repair one-liner keeps the node identity.',
      },
      {
        title: 'Disk hygiene',
        body: 'Log caps and scheduled cleanup on every node, with an alert before a disk fills.',
      },
    ],
  },
  {
    id: 'ai',
    icon: BotIcon,
    title: 'AI gateway',
    lead: 'One place for model keys and model spend.',
    docs: 'guides/ai-gateway',
    items: [
      {
        title: 'Provider keys stay server-side',
        body: 'Paste an Anthropic or OpenAI key once. Apps get revocable virtual keys with rate and spend limits.',
      },
      {
        title: 'Metering',
        body: 'Usage and cost by model, key and day, and a request log when you need the receipts.',
      },
    ],
  },
  {
    id: 'observe',
    icon: ActivityIcon,
    title: 'Observability',
    lead: 'Know what is happening without adding another vendor.',
    docs: 'guides/observability',
    items: [
      {
        title: 'OpenTelemetry, wired in',
        body: 'Deploys get OTel settings injected. Traces, a service map, metrics and logs land in a ClickHouse store on your nodes.',
      },
      {
        title: 'Alerts, incidents, status pages',
        body: 'Alert rules, incident timelines and a public status page. Notify Slack, Teams, Discord, Telegram, ntfy, Gotify, email or a webhook.',
      },
      {
        title: 'Session replay',
        body: 'See what a user saw before a bug.',
        coming: true,
      },
      {
        title: 'Error tracking',
        body: 'Grouped exceptions with stack traces, linked to the deploy that caused them.',
        coming: true,
      },
    ],
  },
  {
    id: 'govern',
    icon: ShieldCheckIcon,
    title: 'Teams, security and APIs',
    lead: 'Built for more than one person from the start.',
    docs: 'guides/account-security',
    items: [
      {
        title: 'Teams and fine-grained access',
        body: 'Roles, attribute-based policies and per-resource grants. Every change lands in an audit log.',
      },
      {
        title: 'SSO and 2FA',
        body: 'Any OIDC provider or a social login, passkeys, and authenticator-app two-factor.',
      },
      {
        title: 'Guardrails',
        body: 'Image CVE scans and signing, production safety rules, and admission checks on every deploy.',
      },
      {
        title: 'REST API, SDKs and Terraform',
        body: 'An OpenAPI REST API with Go, Python and TypeScript SDKs and an official Terraform provider.',
      },
      {
        title: 'Developer CLI and MCP server',
        body: 'Deploy, tail logs and pull env from your terminal, or let an AI agent drive swarmy.',
        coming: true,
      },
    ],
  },
  {
    id: 'platform',
    icon: GitBranchIcon,
    title: 'Developer platform',
    lead: 'The building blocks apps usually rent from someone else.',
    docs: 'concepts/apps',
    items: [
      {
        title: 'Email service',
        body: 'Send transactional email from your own infrastructure.',
        coming: true,
      },
      {
        title: 'Queues and a queue studio',
        body: 'Managed BullMQ queues, with a studio to inspect and retry jobs.',
        coming: true,
      },
      {
        title: 'Auth for your apps',
        body: 'Sign-in for the apps you deploy, backed by swarmy.',
        coming: true,
      },
    ],
  },
];

function Features() {
  return (
    <MarketingLayout>
      <PageIntro
        eyebrow="Features"
        title={
          <>
            Everything it does. <em>Honestly</em>.
          </>
        }
      >
        This page lists what works in swarmy today. Anything marked <ComingTag /> is designed and on
        the roadmap, but not shipped yet.
      </PageIntro>

      <nav aria-label="Feature groups" className="mx-auto mb-12 max-w-6xl px-6">
        <ul className="flex flex-wrap justify-center gap-2">
          {GROUPS.map((g) => (
            <li key={g.id}>
              <a
                href={`#${g.id}`}
                className="hover:bg-accent inline-flex items-center gap-2 rounded-full border px-4 py-1.5 text-sm"
              >
                <g.icon className="text-primary size-4" aria-hidden /> {g.title}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      <div className="mx-auto flex max-w-6xl flex-col gap-20 px-6 pb-24">
        {GROUPS.map((g) => (
          <section key={g.id} id={g.id} aria-labelledby={`${g.id}-title`} className="scroll-mt-24">
            <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
              <div className="max-w-2xl">
                <span className="bg-primary/10 text-primary flex size-10 items-center justify-center rounded-xl">
                  <g.icon className="size-5" aria-hidden />
                </span>
                <h2 id={`${g.id}-title`} className="headline mt-4 text-3xl sm:text-4xl">
                  {g.title}
                </h2>
                <p className="text-muted-foreground mt-3">{g.lead}</p>
              </div>
              <Link
                to="/docs/$"
                params={{ _splat: g.docs }}
                className="text-primary inline-flex items-center gap-1.5 text-sm font-semibold hover:underline"
              >
                Read the docs <span aria-hidden>→</span>
              </Link>
            </div>
            <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {g.items.map((it) => (
                <li
                  key={it.title}
                  className={`card-pop flex flex-col gap-2 p-6 ${it.coming ? 'border-dashed opacity-80' : ''}`}
                >
                  <h3 className="flex items-center justify-between gap-3 font-bold tracking-tight">
                    {it.title} {it.coming ? <ComingTag /> : null}
                  </h3>
                  <p className="text-muted-foreground text-sm">{it.body}</p>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      <section className="mx-auto max-w-6xl px-6 pb-24">
        <div className="ink-block rounded-2xl px-8 py-12 text-center">
          <h2 className="headline text-3xl sm:text-4xl">
            See it <em>for yourself</em>.
          </h2>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <Button asChild size="lg">
              <Link to="/docs/$" params={{ _splat: 'getting-started/install' }}>
                Install swarmy
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline" className="bg-transparent text-inherit">
              <Link to="/compare">Compare with others</Link>
            </Button>
          </div>
        </div>
      </section>
    </MarketingLayout>
  );
}
