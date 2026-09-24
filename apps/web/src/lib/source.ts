import { loader } from 'fumadocs-core/source';
import { defineDocs } from 'fumadocs-mdx/macro';

/**
 * The docs collection: every .md/.mdx under apps/web/content/docs. Folder
 * structure + each folder's meta.json become the sidebar. Bodies load lazily
 * (`async`), so a docs page only ships its own compiled MDX.
 *
 * The `fumadocs-mdx/macro` call is expanded at build time by the fumadocs-mdx
 * Vite plugin — there is no generated `.source/` dir to commit or typecheck.
 */
export const docs = defineDocs({
  dir: 'content/docs',
  docs: { async: true },
});

export const source = loader({
  baseUrl: '/docs',
  source: docs.toFumadocsSource(),
});
