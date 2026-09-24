import { SITE_DESCRIPTION, SITE_NAME, SITE_URL } from './site';

export interface SeoInput {
  /** Page title without the site suffix. Omit for the home page. */
  title?: string;
  description?: string;
  /** Path of the page, e.g. `/features`. Used for canonical + og:url. */
  path: string;
  type?: 'website' | 'article';
}

/**
 * `head()` meta + links for one page: title, description, canonical, Open
 * Graph and Twitter cards. Every route calls this so no page ships without
 * them (Lighthouse SEO audits all of these).
 */
export function seo({ title, description = SITE_DESCRIPTION, path, type = 'website' }: SeoInput) {
  const fullTitle = title
    ? `${title} · ${SITE_NAME}`
    : `${SITE_NAME} — your own cloud, on your own servers`;
  const url = `${SITE_URL}${path === '/' ? '/' : path}`;
  const image = `${SITE_URL}/og.png`;
  return {
    meta: [
      { title: fullTitle },
      { name: 'description', content: description },
      { property: 'og:type', content: type },
      { property: 'og:site_name', content: SITE_NAME },
      { property: 'og:title', content: fullTitle },
      { property: 'og:description', content: description },
      { property: 'og:url', content: url },
      { property: 'og:image', content: image },
      { name: 'twitter:card', content: 'summary_large_image' },
      { name: 'twitter:title', content: fullTitle },
      { name: 'twitter:description', content: description },
      { name: 'twitter:image', content: image },
    ],
    links: [{ rel: 'canonical', href: url }],
  };
}
