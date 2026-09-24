import { createFileRoute, Link } from '@tanstack/react-router';
import {
  ActivityIcon,
  BlocksIcon,
  DatabaseIcon,
  GitBranchIcon,
  GlobeIcon,
  NetworkIcon,
  SparklesIcon,
  WaypointsIcon,
} from 'lucide-react';
import { Button } from '@swarmy/ui/components/button';
import { InstallCommand } from '@/components/install-command';
import { MarketingLayout } from '@/components/marketing-layout';
import { seo } from '@/lib/seo';
import { DEMO_URL, GITHUB_URL } from '@/lib/site';

export const Route = createFileRoute('/')({
  head: () => seo({ path: '/' }),
  component: Home,
});

const STATS = [
  { value: '1', label: 'line to install' },
  { value: '0', label: 'inbound ports on nodes' },
  { value: '69', label: 'one-click templates' },
  { value: '0', label: 'cloud accounts needed' },
];

const STAGES = [
  {
    when: 'Day one',
    title: 'Click, and it runs',
    body: 'Install on one server. Pick WordPress, Plausible or Uptime Kuma from the catalogue, type a domain, get HTTPS. Backups start the moment you add a destination.',
  },
  {
    when: 'Week one',
    title: 'Push, and it deploys',
    body: 'Connect GitHub in one click. A swarmy.yaml in your repo declares services, a Postgres, a cache and a domain; every push is a health-gated deploy, every PR a preview.',
  },
  {
    when: 'Year one',
    title: 'Run a fleet',
    body: 'Add servers in other rooms and regions. A WireGuard mesh joins them, geo-DNS sends users to the nearest edge, Postgres fails over, and Terraform manages the lot.',
  },
];

const HIGHLIGHTS = [
  {
    icon: GitBranchIcon,
    title: 'Git apps with swarmy.yaml',
    body: 'One file declares the app and everything it needs. A push is the deploy; deletes never auto-apply.',
  },
  {
    icon: BlocksIcon,
    title: '69 one-click templates',
    body: 'Self-hosted favourites, wired to managed data where it makes sense.',
  },
  {
    icon: DatabaseIcon,
    title: 'Managed Postgres, with backups',
    body: 'Replicas, failover and point-in-time recovery. Encrypted restic backups and restore drills you can actually run.',
  },
  {
    icon: GlobeIcon,
    title: 'A geo-DNS edge',
    body: 'Automatic TLS on Caddy, an authoritative DNS server on your own nodes, and routing to the nearest region.',
  },
  {
    icon: WaypointsIcon,
    title: 'A mesh between sites',
    body: 'Nodes dial out, so they work behind NAT. A WireGuard mesh links the office, the rack and the VPS.',
  },
  {
    icon: ActivityIcon,
    title: 'Observability built in',
    body: 'OpenTelemetry traces, logs and metrics, alerts, incidents and a public status page.',
  },
];

const SWARMY_YAML = `version: 1
app: blog
services:
  web:
    build: .
    port: 3000
    domains: [blog.example.com]
    env:
      DATABASE_URL: \${{ db.url }}
resources:
  db: postgres`;

function Home() {
  return (
    <MarketingLayout>
      <section className="mesh relative overflow-hidden">
        <div className="mx-auto max-w-4xl px-6 pt-20 pb-20 text-center lg:pt-28">
          <span className="eyebrow">
            <span className="pulse-dot" /> Open source · self-hosted
          </span>
          <h1 className="headline mt-6 text-[2.7rem] sm:text-7xl/[5rem]">
            Your own cloud. <em>On your own servers</em>.
          </h1>
          <p className="text-muted-foreground mx-auto mt-7 max-w-2xl text-lg">
            swarmy turns one VPS, a rack in the office, or both into a platform like the ones you
            rent: git deploys, managed Postgres, a global edge, a mesh and observability. It all
            runs on your machines. There is no swarmy cloud to sign up for.
          </p>
          <InstallCommand className="mx-auto mt-10 max-w-3xl" />
          <p className="text-muted-foreground mt-3 text-xs">
            Ubuntu or Debian, as root. Installs Docker if it's missing. Prints your dashboard URL.
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <Button asChild size="lg">
              <Link to="/docs/$" params={{ _splat: 'getting-started/quickstart' }}>
                Read the quickstart
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <a href={DEMO_URL}>
                <SparklesIcon aria-hidden /> Try the live demo
              </a>
            </Button>
            <Button asChild size="lg" variant="ghost">
              <a href={GITHUB_URL}>View on GitHub</a>
            </Button>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-6 pb-20" aria-label="At a glance">
        <dl className="ink-block grid grid-cols-2 gap-8 rounded-2xl px-8 py-9 text-center sm:grid-cols-4">
          {STATS.map((s) => (
            <div key={s.label} className="flex flex-col">
              <dt className="mono-label order-2 mt-1 opacity-70">{s.label}</dt>
              <dd className="mono-data -order-1 text-4xl font-bold">{s.value}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="mx-auto max-w-6xl px-6 pb-24">
        <div className="max-w-2xl">
          <span className="eyebrow">Novice to expert</span>
          <h2 className="headline mt-4 text-3xl sm:text-4xl">
            Start with a click. <em>Grow into a fleet</em>.
          </h2>
          <p className="text-muted-foreground mt-4">
            The same install serves a first self-hoster and a team running several regions. You
            never switch tools, and you never hit a wall where the answer is "move to the cloud".
          </p>
        </div>
        <ol className="mt-10 grid gap-4 md:grid-cols-3">
          {STAGES.map((s, i) => (
            <li key={s.when} className="card-pop flex flex-col gap-3 p-6">
              <p className="mono-label">
                <span className="text-primary">0{i + 1}</span> · {s.when}
              </p>
              <h3 className="headline text-2xl">{s.title}</h3>
              <p className="text-muted-foreground text-sm">{s.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="mx-auto max-w-6xl px-6 pb-24">
        <div className="grid items-center gap-10 lg:grid-cols-2">
          <div>
            <span className="eyebrow">Git apps</span>
            <h2 className="headline mt-4 text-3xl sm:text-4xl">
              The repo is <em>the control panel</em>.
            </h2>
            <p className="text-muted-foreground mt-4">
              Add a <code className="mono-data text-foreground">swarmy.yaml</code> and push. swarmy
              shows the plan in plain words ("create postgres 16 db · build web · route
              blog.example.com"), then applies it. Add a cache to the file and the cache exists,
              with <code className="mono-data text-foreground">REDIS_URL</code> wired in. Remove the
              database and nothing is deleted: the dashboard asks you first.
            </p>
            <p className="text-muted-foreground mt-4">
              It compiles to plain Docker Compose, so you can export it and leave any time.
            </p>
            <Link
              to="/docs/$"
              params={{ _splat: 'guides/deploy-from-git' }}
              className="text-primary mt-6 inline-flex items-center gap-1.5 text-sm font-semibold hover:underline"
            >
              Deploy from git <span aria-hidden>→</span>
            </Link>
          </div>
          <figure className="ink-block overflow-hidden rounded-2xl border border-white/10">
            <figcaption className="mono-label flex items-center gap-2 border-b border-white/10 px-5 py-3 text-white/60">
              <span className="bg-primary size-2 rounded-full" aria-hidden /> swarmy.yaml
            </figcaption>
            <pre className="mono-data overflow-x-auto p-5 text-sm leading-6">
              <code>{SWARMY_YAML}</code>
            </pre>
          </figure>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-6 pb-24">
        <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
          <div className="max-w-2xl">
            <span className="eyebrow">What's in the box</span>
            <h2 className="headline mt-4 text-3xl sm:text-4xl">
              A whole platform. <em>One install</em>.
            </h2>
          </div>
          <Link
            to="/features"
            className="text-primary inline-flex items-center gap-1.5 text-sm font-semibold hover:underline"
          >
            All features <span aria-hidden>→</span>
          </Link>
        </div>
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {HIGHLIGHTS.map((f) => (
            <li key={f.title} className="card-pop card-pop-hover flex flex-col gap-3 p-6">
              <span className="bg-primary/10 text-primary flex size-10 items-center justify-center rounded-xl">
                <f.icon className="size-5" aria-hidden />
              </span>
              <h3 className="font-bold tracking-tight">{f.title}</h3>
              <p className="text-muted-foreground text-sm">{f.body}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="mx-auto max-w-6xl px-6 pb-24">
        <div className="card-pop grid gap-8 p-8 md:grid-cols-[1fr_1.3fr] md:p-12">
          <div>
            <span className="bg-primary/10 text-primary flex size-10 items-center justify-center rounded-xl">
              <NetworkIcon className="size-5" aria-hidden />
            </span>
            <h2 className="headline mt-5 text-3xl">
              No cloud <em>dependency</em>.
            </h2>
          </div>
          <ul className="text-muted-foreground flex flex-col gap-4 text-sm">
            <li>
              <strong className="text-foreground">The controller runs on your server.</strong> No
              hosted control plane and no account with us. If we vanished tomorrow, your platform
              would keep running.
            </li>
            <li>
              <strong className="text-foreground">Your data stays on your disks.</strong> Postgres,
              object storage (Garage) and backups live on your nodes or in the S3 bucket you choose.
            </li>
            <li>
              <strong className="text-foreground">Your GitHub App, not ours.</strong> Connecting
              GitHub registers an app owned by your instance. No token passes through a third party.
            </li>
            <li>
              <strong className="text-foreground">Plain Docker underneath.</strong> Everything is a
              Swarm service with labels. Export Compose and walk away whenever you like.
            </li>
          </ul>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-6 pb-24">
        <div className="ink-block relative overflow-hidden rounded-2xl px-8 py-14 text-center">
          <h2 className="headline text-3xl sm:text-5xl">
            Ten minutes to <em>your own cloud</em>.
          </h2>
          <p className="mx-auto mt-5 max-w-lg text-base opacity-80">
            From an empty server to a WordPress site on HTTPS, a second node, a teammate and
            backups.
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <Button asChild size="lg">
              <Link to="/docs/$" params={{ _splat: 'getting-started/quickstart' }}>
                Start the quickstart
              </Link>
            </Button>
            <Button asChild size="lg" variant="outline" className="bg-transparent text-inherit">
              <Link to="/compare">How it compares</Link>
            </Button>
          </div>
        </div>
      </section>
    </MarketingLayout>
  );
}
