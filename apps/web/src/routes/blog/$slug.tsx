import { createFileRoute, Link, notFound } from '@tanstack/react-router';
import { MarketingLayout } from '@/components/marketing-layout';
import { BLOG_POSTS } from '@/lib/blog';
import { seo } from '@/lib/seo';

export const Route = createFileRoute('/blog/$slug')({
  loader: ({ params }) => {
    const post = BLOG_POSTS.find((p) => p.slug === params.slug);
    if (!post) throw notFound();
    return post;
  },
  head: ({ loaderData }) =>
    loaderData
      ? seo({
          title: loaderData.title,
          description: loaderData.description,
          path: `/blog/${loaderData.slug}`,
          type: 'article',
        })
      : {},
  component: BlogPostPage,
});

function BlogPostPage() {
  const post = Route.useLoaderData();
  return (
    <MarketingLayout>
      <article className="mx-auto max-w-2xl px-6 pt-20 pb-24">
        <Link to="/blog" className="text-primary text-sm font-semibold hover:underline">
          ← All posts
        </Link>
        <p className="mono-label mt-8">
          <time dateTime={post.date}>{post.date}</time> · {post.author}
        </p>
        <h1 className="headline mt-3 text-4xl sm:text-5xl">{post.title}</h1>
        <p className="text-muted-foreground mt-5 text-lg">{post.description}</p>
        <div className="mt-10 flex flex-col gap-5 text-base leading-7">
          {post.body.map((para) => (
            <p key={para.slice(0, 32)}>{para}</p>
          ))}
        </div>
      </article>
    </MarketingLayout>
  );
}
