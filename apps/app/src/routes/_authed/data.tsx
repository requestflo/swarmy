import * as React from 'react';
import { Link, createFileRoute } from '@tanstack/react-router';
import {
  ArchiveIcon,
  BoxIcon,
  DatabaseIcon,
  SearchIcon,
  ZapIcon,
  type LucideIcon,
} from 'lucide-react';
import { PageHeader } from '@/components/page-header';

export const Route = createFileRoute('/_authed/data')({
  component: DataPage,
});

interface DataService {
  to: string;
  label: string;
  description: string;
  icon: LucideIcon;
}

/** The managed data services swarmy can run on the user's own nodes. */
const SERVICES: DataService[] = [
  {
    to: '/',
    label: 'Databases',
    description:
      'Managed Postgres with HA topologies, PITR backups and failover — provisioned per stack.',
    icon: DatabaseIcon,
  },
  {
    to: '/data/cache',
    label: 'Caches',
    description: 'Redis / Valkey — single node to sentinel HA, private by default.',
    icon: ZapIcon,
  },
  {
    to: '/data/buckets',
    label: 'Buckets',
    description: 'S3-compatible object storage — buckets, keys and app attachment.',
    icon: ArchiveIcon,
  },
  {
    to: '/data/search',
    label: 'Search',
    description: 'Meilisearch / Typesense search engines attached to your apps.',
    icon: SearchIcon,
  },
  {
    to: '/data/vector',
    label: 'Vector stores',
    description: 'Qdrant / pgvector for AI and embedding workloads.',
    icon: BoxIcon,
  },
];

function DataPage(): React.JSX.Element {
  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 lg:pb-20 xl:px-10">
      <PageHeader
        eyebrow="Data"
        title={
          <>
            Data <em>services</em>.
          </>
        }
        description="Managed Postgres, caches, search, vector stores and object buckets — provisioned and run on your own swarm."
      />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {SERVICES.map((s) => (
          <Link key={s.label} to={s.to} className="card-pop group block p-5">
            <div className="flex items-start gap-3">
              <s.icon className="mt-0.5 size-5 shrink-0" aria-hidden />
              <div>
                <div className="font-medium group-hover:underline">{s.label}</div>
                <p className="text-muted-foreground mt-1 text-sm">{s.description}</p>
              </div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
