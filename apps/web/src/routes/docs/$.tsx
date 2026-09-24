import { Suspense, use } from 'react';
import { createFileRoute, notFound } from '@tanstack/react-router';
import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
  EditOnGitHub,
} from 'fumadocs-ui/layouts/docs/page';
import { useMDXComponents } from '@/components/mdx';
import { baseOptions } from '@/lib/layout.shared';
import { seo } from '@/lib/seo';
import { GITHUB_URL } from '@/lib/site';
import { docs, source } from '@/lib/source';

/**
 * Every docs page. The loader is isomorphic on purpose (no server function):
 * the site is fully prerendered and served as static files, so client-side
 * navigation must not need a server. The page index is small and ships to the
 * client; each page's compiled MDX is its own lazily loaded chunk.
 */
export const Route = createFileRoute('/docs/$')({
  loader: async ({ params }) => {
    const slugs = (params._splat ?? '').split('/').filter(Boolean);
    const page = source.getPage(slugs);
    if (!page) throw notFound();
    await docs.getPage(page.path)?.preload();
    return {
      path: page.path,
      url: page.url,
      title: page.data.title ?? 'Docs',
      description: page.data.description,
    };
  },
  head: ({ loaderData }) =>
    loaderData
      ? seo({
          title: loaderData.title,
          description: loaderData.description,
          path: loaderData.url,
          type: 'article',
        })
      : {},
  component: Page,
});

function Page() {
  const { path } = Route.useLoaderData();
  return (
    <DocsLayout {...baseOptions()} tree={source.getPageTree()}>
      <Suspense>
        <Content path={path} />
      </Suspense>
    </DocsLayout>
  );
}

function Content({ path }: { path: string }) {
  const page = docs.getPage(path);
  if (!page) throw new Error(`unknown docs page: ${path}`);
  const { toc } = use(page.load());
  const MDX = page.body;
  return (
    <DocsPage toc={toc} tableOfContent={{ style: 'clerk' }}>
      <DocsTitle>{page.title}</DocsTitle>
      <DocsDescription>{page.description}</DocsDescription>
      <DocsBody>
        <MDX components={useMDXComponents()} />
      </DocsBody>
      <EditOnGitHub href={`${GITHUB_URL}/blob/main/apps/web/content/docs/${path}`} />
    </DocsPage>
  );
}
