import { createFileRoute, Link } from '@tanstack/react-router';
import { CheckIcon } from 'lucide-react';
import { Button } from '@swarmy/ui/components/button';
import { ComingTag, MarketingLayout, PageIntro } from '@/components/marketing-layout';
import { seo } from '@/lib/seo';
import { GITHUB_URL } from '@/lib/site';

export const Route = createFileRoute('/pricing')({
  head: () =>
    seo({
      title: 'Pricing',
      description:
        'swarmy is open source and free to self-host, with every feature included. You pay only for your own servers.',
      path: '/pricing',
    }),
  component: Pricing,
});

const INCLUDED = [
  'Every feature — no paid edition, no feature gates',
  'Unlimited servers, apps, databases and team members',
  'SSO, access policies and the audit log',
  'Managed Postgres, backups and restore drills',
  'The geo-DNS edge and the mesh',
  'The REST API, SDKs and Terraform provider',
];

function Pricing() {
  return (
    <MarketingLayout>
      <PageIntro
        eyebrow="Pricing"
        title={
          <>
            Free. <em>Your servers, your bill</em>.
          </>
        }
      >
        swarmy is open source. You run it on machines you already have or rent, and you pay only for
        those.
      </PageIntro>

      <section className="mx-auto grid max-w-5xl gap-6 px-6 pb-24 md:grid-cols-2">
        <div className="card-pop ring-primary/40 flex flex-col p-8 ring-2">
          <p className="mono-label text-primary">Self-hosted</p>
          <p className="headline mt-3 text-5xl">
            $0 <span className="text-muted-foreground text-base font-normal">forever</span>
          </p>
          <p className="text-muted-foreground mt-3 text-sm">
            Licensed FSL-1.1-ALv2: use it for anything except offering swarmy itself as a competing
            hosted service. Each release becomes Apache 2.0 after two years.
          </p>
          <ul className="mt-6 flex flex-col gap-3 text-sm">
            {INCLUDED.map((i) => (
              <li key={i} className="flex gap-2">
                <CheckIcon className="text-status-online mt-0.5 size-4 shrink-0" aria-hidden /> {i}
              </li>
            ))}
          </ul>
          <div className="mt-8 flex flex-wrap gap-3">
            <Button asChild size="lg">
              <Link to="/docs/$" params={{ _splat: 'getting-started/install' }}>
                Install swarmy
              </Link>
            </Button>
            <Button asChild size="lg" variant="ghost">
              <a href={GITHUB_URL}>Source on GitHub</a>
            </Button>
          </div>
        </div>

        <div className="card-pop flex flex-col border-dashed p-8">
          <p className="mono-label flex items-center gap-2">
            Support & managed options <ComingTag />
          </p>
          <p className="headline mt-3 text-3xl">Not yet.</p>
          <p className="text-muted-foreground mt-3 text-sm">
            We do not sell anything today. If you need a support contract, help with a migration, or
            someone else to run the controller for you, open an issue and tell us. It helps us
            decide what to offer first.
          </p>
          <div className="mt-auto pt-8">
            <Button asChild variant="outline">
              <a href={`${GITHUB_URL}/issues`}>Tell us what you need</a>
            </Button>
          </div>
        </div>
      </section>
    </MarketingLayout>
  );
}
