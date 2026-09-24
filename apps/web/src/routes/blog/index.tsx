import { createFileRoute, Link } from '@tanstack/react-router';
import { MarketingLayout, PageIntro } from '@/components/marketing-layout';
import { BLOG_POSTS } from '@/lib/blog';
import { seo } from '@/lib/seo';

export const Route = createFileRoute('/blog/')({
  head: () =>
    seo({
      title: 'Blog',
      description: 'Releases, design notes and stories from running swarmy.',
      path: '/blog',
    }),
  component: BlogIndex,
});

function BlogIndex() {
  return (
    <MarketingLayout>
      <PageIntro
        eyebrow="Blog"
        title={
          <>
            Notes from <em>the swarm</em>.
          </>
        }
      >
        Releases, design decisions, and what we learn running swarmy on real servers.
      </PageIntro>
      <section className="mx-auto max-w-3xl px-6 pb-24">
        <ul className="flex flex-col gap-4">
          {BLOG_POSTS.map((p) => (
            <li key={p.slug}>
              <Link
                to="/blog/$slug"
                params={{ slug: p.slug }}
                className="card-pop card-pop-hover block p-6"
              >
                <p className="mono-label">
                  <time dateTime={p.date}>{p.date}</time>
                </p>
                <h2 className="headline mt-2 text-2xl">{p.title}</h2>
                <p className="text-muted-foreground mt-2">{p.description}</p>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </MarketingLayout>
  );
}
