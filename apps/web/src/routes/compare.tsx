import { createFileRoute, Link } from '@tanstack/react-router';
import { MarketingLayout, PageIntro } from '@/components/marketing-layout';
import { seo } from '@/lib/seo';

export const Route = createFileRoute('/compare')({
  head: () =>
    seo({
      title: 'swarmy vs Dokploy, Coolify and Railway',
      description:
        'An honest comparison of swarmy with Dokploy, Coolify and Railway: where swarmy is ahead, where it is behind, and who should pick what.',
      path: '/compare',
    }),
  component: Compare,
});

/** yes = first-class · part = partial / with caveats · no = missing · na = not applicable */
type Mark = 'yes' | 'part' | 'no' | 'na';
type Cell = Mark | [Mark, string];

interface Row {
  label: string;
  swarmy: Cell;
  dokploy: Cell;
  coolify: Cell;
  railway: Cell;
}

interface Section {
  title: string;
  rows: Row[];
}

// Competitor facts: their docs, repos and changelogs, read 2026-09-24.
// Self-hosted open-source editions unless noted. Railway is hosted SaaS.
const SECTIONS: Section[] = [
  {
    title: 'Deploy and build',
    rows: [
      {
        label: 'Git deploys (GitHub, GitLab)',
        swarmy: 'yes',
        dokploy: 'yes',
        coolify: 'yes',
        railway: 'yes',
      },
      {
        label: 'Gitea / self-hosted git',
        swarmy: 'yes',
        dokploy: 'yes',
        coolify: 'yes',
        railway: 'no',
      },
      {
        label: 'One-click GitHub App',
        swarmy: 'yes',
        dokploy: 'yes',
        coolify: 'yes',
        railway: 'yes',
      },
      {
        label: 'Builds without a Dockerfile',
        swarmy: ['no', 'coming'],
        dokploy: 'yes',
        coolify: 'yes',
        railway: 'yes',
      },
      {
        label: 'Declarative app file in the repo',
        swarmy: ['yes', 'swarmy.yaml'],
        dokploy: 'no',
        coolify: 'no',
        railway: ['part', 'railway.json'],
      },
      {
        label: 'Lossless Compose export (no lock-in)',
        swarmy: 'yes',
        dokploy: 'no',
        coolify: 'no',
        railway: 'no',
      },
      {
        label: 'PR preview environments',
        swarmy: 'yes',
        dokploy: ['part', 'GitHub, no compose'],
        coolify: 'yes',
        railway: 'yes',
      },
      {
        label: 'One-click templates',
        swarmy: ['part', '69'],
        dokploy: ['yes', '500+'],
        coolify: ['yes', '350+'],
        railway: ['yes', '2,000+'],
      },
    ],
  },
  {
    title: 'Releases',
    rows: [
      {
        label: 'Health-gated deploy + auto-rollback',
        swarmy: 'yes',
        dokploy: 'part',
        coolify: 'part',
        railway: 'yes',
      },
      {
        label: 'Canary / weighted traffic',
        swarmy: 'yes',
        dokploy: 'no',
        coolify: 'no',
        railway: 'no',
      },
      { label: 'Scale to zero', swarmy: 'yes', dokploy: 'no', coolify: 'no', railway: 'yes' },
    ],
  },
  {
    title: 'Edge and network',
    rows: [
      { label: 'Automatic TLS', swarmy: 'yes', dokploy: 'yes', coolify: 'yes', railway: 'yes' },
      {
        label: 'Rate limit / IP / country rules per route',
        swarmy: 'yes',
        dokploy: 'no',
        coolify: 'part',
        railway: 'part',
      },
      {
        label: 'Authoritative geo-DNS, multi-region edge',
        swarmy: 'yes',
        dokploy: 'no',
        coolify: 'no',
        railway: 'part',
      },
      {
        label: 'Nodes behind NAT (dial-out agent)',
        swarmy: 'yes',
        dokploy: 'no',
        coolify: 'no',
        railway: 'na',
      },
      {
        label: 'WireGuard mesh across sites',
        swarmy: 'yes',
        dokploy: ['part', 'guide'],
        coolify: ['part', 'guide'],
        railway: 'yes',
      },
    ],
  },
  {
    title: 'Data',
    rows: [
      {
        label: 'Managed Postgres with replicas and failover',
        swarmy: 'yes',
        dokploy: ['part', 'single'],
        coolify: ['part', 'single'],
        railway: 'yes',
      },
      {
        label: 'Point-in-time recovery',
        swarmy: 'yes',
        dokploy: 'no',
        coolify: 'no',
        railway: 'yes',
      },
      {
        label: 'Managed MySQL / MariaDB / Mongo',
        swarmy: ['part', 'backups + restore only'],
        dokploy: 'yes',
        coolify: 'yes',
        railway: 'yes',
      },
      {
        label: 'S3 object storage on your nodes',
        swarmy: 'yes',
        dokploy: 'no',
        coolify: 'no',
        railway: 'yes',
      },
      { label: 'Encrypted backups', swarmy: 'yes', dokploy: 'no', coolify: 'part', railway: 'yes' },
      {
        label: 'Restore drills / backup verification',
        swarmy: 'yes',
        dokploy: 'no',
        coolify: 'no',
        railway: 'no',
      },
    ],
  },
  {
    title: 'Operate',
    rows: [
      {
        label: 'Traces and service map (OpenTelemetry)',
        swarmy: 'yes',
        dokploy: 'no',
        coolify: 'no',
        railway: 'part',
      },
      {
        label: 'Alerts, incidents, public status page',
        swarmy: 'yes',
        dokploy: 'part',
        coolify: 'part',
        railway: 'part',
      },
      { label: 'Web terminal', swarmy: 'yes', dokploy: 'yes', coolify: 'yes', railway: 'yes' },
      {
        label: 'Provision cloud servers from the UI',
        swarmy: 'no',
        dokploy: 'no',
        coolify: 'yes',
        railway: 'na',
      },
    ],
  },
  {
    title: 'Access and API',
    rows: [
      {
        label: 'OIDC SSO',
        swarmy: 'yes',
        dokploy: ['part', 'paid edition'],
        coolify: 'part',
        railway: 'yes',
      },
      {
        label: 'Fine-grained access policies',
        swarmy: 'yes',
        dokploy: ['part', 'paid edition'],
        coolify: 'no',
        railway: 'part',
      },
      {
        label: 'Audit log',
        swarmy: 'yes',
        dokploy: ['part', 'paid edition'],
        coolify: 'part',
        railway: 'yes',
      },
      {
        label: 'Image CVE scan + signing gate',
        swarmy: 'yes',
        dokploy: 'no',
        coolify: 'no',
        railway: 'no',
      },
      {
        label: 'Official Terraform provider',
        swarmy: 'yes',
        dokploy: ['no', 'community'],
        coolify: ['no', 'community'],
        railway: 'part',
      },
      {
        label: 'Developer CLI',
        swarmy: ['no', 'coming'],
        dokploy: 'yes',
        coolify: 'yes',
        railway: 'yes',
      },
      {
        label: 'MCP server',
        swarmy: ['no', 'coming'],
        dokploy: 'yes',
        coolify: 'yes',
        railway: 'yes',
      },
      {
        label: 'AI gateway (model keys, metering)',
        swarmy: 'yes',
        dokploy: 'no',
        coolify: 'no',
        railway: 'no',
      },
    ],
  },
];

const MARK_TEXT: Record<Mark, { symbol: string; label: string; className: string }> = {
  yes: { symbol: '✓', label: 'Yes', className: 'text-status-online' },
  part: { symbol: '◐', label: 'Partly', className: 'text-status-warning' },
  no: { symbol: '✗', label: 'No', className: 'text-muted-foreground' },
  na: { symbol: '—', label: 'Not applicable', className: 'text-muted-foreground' },
};

function CellView({ cell }: { cell: Cell }) {
  const [mark, note] = Array.isArray(cell) ? cell : [cell, undefined];
  const m = MARK_TEXT[mark];
  return (
    <td className="px-4 py-3 text-center">
      <span className={`font-bold ${m.className}`} aria-label={m.label} role="img">
        {m.symbol}
      </span>
      {note ? <span className="text-muted-foreground block text-xs">{note}</span> : null}
    </td>
  );
}

const PICKS = [
  {
    name: 'Pick Dokploy or Coolify if…',
    body: 'you want the largest template catalogue today, builds without a Dockerfile, a developer CLI or MCP server now, or managed MySQL and Mongo. Both have years of production use and big communities. Coolify can also create servers at Hetzner, DigitalOcean and Vultr for you.',
  },
  {
    name: 'Pick Railway if…',
    body: 'you do not want to run servers at all. It is hosted: nothing to patch, nothing to back up yourself, and you pay for usage. You also accept that your apps and data live on their cloud.',
  },
  {
    name: 'Pick swarmy if…',
    body: 'you want the platform layer those tools stop short of on your own hardware: Postgres with failover and PITR, backups you can drill, a multi-region edge with geo-DNS, a mesh across sites, SSO and access policies without a paid edition, and an exit to plain Compose.',
  },
];

function Compare() {
  return (
    <MarketingLayout>
      <PageIntro
        eyebrow="Compare"
        title={
          <>
            swarmy vs <em>the usual suspects</em>.
          </>
        }
      >
        Dokploy and Coolify are the self-hosted platforms people usually compare us with. Railway is
        the hosted platform people want to stop renting. Here is where swarmy is ahead, and where it
        is not.
      </PageIntro>

      <section className="mx-auto max-w-6xl px-6 pb-16">
        <div className="grid gap-4 md:grid-cols-3">
          {PICKS.map((p) => (
            <div key={p.name} className="card-pop p-6">
              <h2 className="font-bold tracking-tight">{p.name}</h2>
              <p className="text-muted-foreground mt-2 text-sm">{p.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-6 pb-12" aria-labelledby="matrix-title">
        <h2 id="matrix-title" className="headline mb-2 text-3xl">
          Feature by feature
        </h2>
        <p className="text-muted-foreground mb-6 text-sm">
          ✓ first-class · ◐ partial or with caveats · ✗ missing · — not applicable. Competitor
          columns describe the self-hosted open-source edition unless noted, from their docs,
          repositories and changelogs as of September 2026. Spotted something out of date?{' '}
          <a
            className="text-primary hover:underline"
            href="https://github.com/requestflo/swarmy/issues"
          >
            Tell us
          </a>
          .
        </p>
        <div className="card-pop overflow-x-auto">
          <table className="w-full min-w-[640px] border-collapse text-sm">
            <thead>
              <tr className="border-b">
                <th scope="col" className="px-4 py-3 text-left font-semibold">
                  Capability
                </th>
                <th scope="col" className="text-primary px-4 py-3 font-semibold">
                  swarmy
                </th>
                <th scope="col" className="px-4 py-3 font-semibold">
                  Dokploy
                </th>
                <th scope="col" className="px-4 py-3 font-semibold">
                  Coolify
                </th>
                <th scope="col" className="px-4 py-3 font-semibold">
                  Railway
                </th>
              </tr>
            </thead>
            {SECTIONS.map((s) => (
              <tbody key={s.title}>
                <tr className="bg-muted/50">
                  <th scope="rowgroup" colSpan={5} className="mono-label px-4 py-2 text-left">
                    {s.title}
                  </th>
                </tr>
                {s.rows.map((r) => (
                  <tr key={r.label} className="border-t">
                    <th scope="row" className="px-4 py-3 text-left font-normal">
                      {r.label}
                    </th>
                    <CellView cell={r.swarmy} />
                    <CellView cell={r.dokploy} />
                    <CellView cell={r.coolify} />
                    <CellView cell={r.railway} />
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-6 pb-24">
        <div className="card-pop grid gap-6 p-8 md:grid-cols-2">
          <div>
            <h2 className="headline text-2xl">Where we are behind</h2>
            <ul className="text-muted-foreground mt-4 list-disc space-y-2 pl-5 text-sm">
              <li>Fewer templates: 69 against several hundred.</li>
              <li>
                No zero-config builds yet: a repo needs a Dockerfile. Railpack support is coming.
              </li>
              <li>
                No managed MySQL, MariaDB or Mongo yet. Compose databases get logical backups and
                restore, not HA.
              </li>
              <li>
                No developer CLI or MCP server yet. The REST API, SDKs and Terraform provider cover
                automation today.
              </li>
              <li>We are new. Dokploy and Coolify have far more installs and community answers.</li>
            </ul>
          </div>
          <div>
            <h2 className="headline text-2xl">Where we are ahead</h2>
            <ul className="text-muted-foreground mt-4 list-disc space-y-2 pl-5 text-sm">
              <li>
                Postgres with replicas, failover and point-in-time recovery, and restore drills.
              </li>
              <li>A multi-region edge with authoritative geo-DNS on your own nodes.</li>
              <li>Nodes that dial out, so servers behind NAT work, joined by a WireGuard mesh.</li>
              <li>SSO, access policies and the audit log in the open-source edition.</li>
              <li>OpenTelemetry traces, an AI gateway, and a lossless Compose export.</li>
            </ul>
          </div>
        </div>
        <p className="text-muted-foreground mt-6 text-center text-sm">
          Want the details? The{' '}
          <Link to="/features" className="text-primary hover:underline">
            features page
          </Link>{' '}
          lists everything swarmy does, and what is still coming.
        </p>
      </section>
    </MarketingLayout>
  );
}
