import {
  ActivityIcon,
  ContainerIcon,
  GitBranchIcon,
  NetworkIcon,
  ServerIcon,
  ShieldCheckIcon,
} from 'lucide-react';
import { Badge, Button, Card, CardContent } from '@swarmy/ui';

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
      <header className="mx-auto flex max-w-6xl items-center justify-between p-6">
        <div className="flex items-center gap-2">
          <div className="bg-primary/10 text-primary flex size-8 items-center justify-center rounded-lg">
            <ContainerIcon className="size-5" />
          </div>
          <span className="text-lg font-semibold tracking-tight">swarmy</span>
        </div>
        <Button asChild variant="outline">
          <a href="http://localhost:3003">Open dashboard</a>
        </Button>
      </header>

      <main>
        <section className="mx-auto max-w-3xl px-6 py-24 text-center">
          <Badge variant="success" className="mb-5">
            Open source · self-hosted
          </Badge>
          <h1 className="text-4xl font-bold tracking-tight sm:text-6xl">
            The Docker Swarm controller that gets out of your way.
          </h1>
          <p className="text-muted-foreground mx-auto mt-6 max-w-xl text-lg">
            Live stats, agent-based node enrollment, and pluggable ingress — a modern, professional
            control plane for your swarm. Like Dokploy, minus the opinions.
          </p>
          <div className="mt-8 flex justify-center gap-3">
            <Button asChild size="lg">
              <a href="http://localhost:3003">Get started</a>
            </Button>
            <Button asChild size="lg" variant="outline">
              <a href="https://github.com/requestflo/swarmy">View on GitHub</a>
            </Button>
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-6 pb-24">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((f) => (
              <Card key={f.title}>
                <CardContent className="flex flex-col gap-3 p-6">
                  <div className="bg-primary/10 text-primary flex size-9 items-center justify-center rounded-lg">
                    <f.icon className="size-5" />
                  </div>
                  <h3 className="font-semibold">{f.title}</h3>
                  <p className="text-muted-foreground text-sm">{f.body}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>
      </main>

      <footer className="text-muted-foreground border-t py-8 text-center text-sm">
        swarmy — MIT licensed.
      </footer>
    </div>
  );
}
