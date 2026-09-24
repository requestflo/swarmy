import { createFileRoute } from '@tanstack/react-router';
import { source } from '@/lib/source';
import { BLOG_POSTS } from '@/lib/blog';
import { MARKETING_ROUTES, SITE_URL } from '@/lib/site';

/** /sitemap.xml — every marketing page, blog post and docs page. Prerendered. */
export const Route = createFileRoute('/sitemap.xml')({
  server: {
    handlers: {
      GET: async () => {
        const paths = [
          ...MARKETING_ROUTES.map((r) => r.path),
          ...BLOG_POSTS.map((p) => `/blog/${p.slug}`),
          ...source.getPages().map((p) => p.url),
        ];
        const body = [
          '<?xml version="1.0" encoding="UTF-8"?>',
          '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
          ...paths.map((p) => `  <url><loc>${SITE_URL}${p}</loc></url>`),
          '</urlset>',
          '',
        ].join('\n');
        return new Response(body, {
          headers: { 'Content-Type': 'application/xml; charset=utf-8' },
        });
      },
    },
  },
});
