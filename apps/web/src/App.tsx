import {
  ActivityIcon,
  ContainerIcon,
  GitBranchIcon,
  NetworkIcon,
  ServerIcon,
  ShieldCheckIcon,
  SparklesIcon,
} from 'lucide-react';
import { Badge, Button, Card, CardContent } from '@swarmy/ui';
import { APP_URL, DEMO_URL } from './config';

const FEATURES = [
  {
    icon: ActivityIcon,
    title: 'Live cluster stats',
    body: 'Real-time CPU, memory, and container metrics streamed from a lightweight agent on every node.',
  },
  {
    icon: ServerIcon,
    title: 'Agent-based enrollment',
    body: 'Nodes dial out over an authenticated WebSocket with a join token — no inbound ports required.',
  },
  {
    icon: NetworkIcon,
    title: 'Pluggable ingress',
    body: 'Caddy, Traefik, or none. Turn it off and own your routing — swarmy never forces a setup on you.',
  },
  {
    icon: ContainerIcon,
    title: 'Services & stacks',
    body: 'Deploy, scale, restart, and roll out compose stacks across the swarm from one slick dashboard.',
  },
  {
    icon: ShieldCheckIcon,
    title: 'Multi-tenant by default',
    body: 'Teams, roles, and per-org isolation backed by Better Auth and Postgres.',
  },
  {
    icon: GitBranchIcon,
    title: 'Unopinionated',
    body: 'A control plane, not a walled garden. Compose it with your existing tools and workflows.',
  },
];

export function App() {
  return (
    <div className="bg-background text-foreground min-h-screen">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-6">
        <div className="flex items-center gap-2">
          <div className="bg-primary/10 text-primary flex size-8 items-center justify-center rounded-xl">
            <ContainerIcon className="size-5" />
          </div>
          <span className="text-lg font-bold tracking-tight">
            swarm<span className="text-primary">y</span>
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button asChild variant="ghost" className="hidden sm:inline-flex">
            <a href={DEMO_URL}>
              <SparklesIcon /> Live demo
            </a>
          </Button>
          <Button asChild variant="outline">
            <a href={APP_URL}>Open dashboard</a>
          </Button>
        </div>
      </header>

      <main>
        <section className="mesh relative overflow-hidden">
          <div className="mx-auto max-w-3xl px-6 pt-20 pb-24 text-center lg:pt-28">
            <span className="eyebrow mb-6">
              <span className="pulse-dot" /> Open source · self-hosted
            </span>
            <h1 className="headline mt-6 text-[2.6rem] sm:text-6xl/[4.4rem]">
              Deploy your swarm. <em>Get out of the way</em>.
            </h1>
            <p className="text-muted-foreground mx-auto mt-7 max-w-xl text-lg">
              Live stats, agent-based node enrollment, and pluggable ingress — a modern, premium
              control plane for Docker Swarm. Like Dokploy, minus the opinions.
            </p>
            <div className="mt-9 flex flex-wrap justify-center gap-3">
              <Button asChild size="lg">
                <a href={APP_URL}>Get started</a>
              </Button>
              <Button asChild size="lg" variant="outline">
                <a href={DEMO_URL}>
                  <SparklesIcon /> Try the live demo
                </a>
              </Button>
              <Button asChild size="lg" variant="ghost">
                <a href="https://github.com/requestflo/swarmy">View on GitHub</a>
              </Button>
            </div>
            <p className="text-muted-foreground/80 mt-4 text-xs">
              No sign-up, no install — the full dashboard, right in your browser.
            </p>
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-6 pb-12">
          <div className="ink-block flex flex-wrap items-center justify-around gap-8 rounded-2xl px-8 py-9 text-center">
            <div>
              <p className="mono-data text-4xl font-bold">∞</p>
              <p className="mono-label mt-1 opacity-70">nodes per swarm</p>
            </div>
            <div>
              <p className="mono-data text-4xl font-bold">0</p>
              <p className="mono-label mt-1 opacity-70">inbound ports</p>
            </div>
            <div>
              <p className="mono-data text-4xl font-bold">2s</p>
              <p className="mono-label mt-1 opacity-70">live refresh</p>
            </div>
            <div>
              <p className="mono-data text-4xl font-bold">FSL</p>
              <p className="mono-label mt-1 opacity-70">licensed</p>
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-6 pb-24">
          <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
            <div className="max-w-2xl">
              <span className="eyebrow mb-4">Features</span>
              <h2 className="headline mt-4 text-3xl sm:text-4xl">
                Everything you need. <em>Nothing you don't</em>.
              </h2>
            </div>
            <a
              href={DEMO_URL}
              className="text-primary inline-flex items-center gap-1.5 text-sm font-semibold hover:underline"
            >
              See it live <span aria-hidden>→</span>
            </a>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((f) => (
              <Card key={f.title} className="card-pop card-pop-hover border-0">
                <CardContent className="flex flex-col gap-3 p-6">
                  <div className="bg-primary/10 text-primary flex size-10 items-center justify-center rounded-xl">
                    <f.icon className="size-5" />
                  </div>
                  <h3 className="font-bold tracking-tight">{f.title}</h3>
                  <p className="text-muted-foreground text-sm">{f.body}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-6 pb-24">
          <div className="ink-block relative overflow-hidden rounded-2xl px-8 py-14 text-center">
            <Badge variant="success" className="mb-5">
              Ready when you are
            </Badge>
            <h2 className="headline text-3xl sm:text-5xl">
              Spin up your <em>control plane</em>.
            </h2>
            <p className="mx-auto mt-5 max-w-lg text-base opacity-80">
              One agent per node, a join token, and you're live. No inbound ports, no walled garden.
            </p>
            <div className="mt-8 flex flex-wrap justify-center gap-3">
              <Button asChild size="lg">
                <a href={APP_URL}>Open dashboard</a>
              </Button>
              <Button asChild size="lg" variant="outline">
                <a href={DEMO_URL}>
                  <SparklesIcon /> Try the live demo
                </a>
              </Button>
            </div>
          </div>
        </section>
      </main>

      <footer className="text-muted-foreground border-t py-8 text-center text-sm">
        swarm<span className="text-primary">y</span> — FSL-1.1 licensed.
      </footer>
    </div>
  );
}
