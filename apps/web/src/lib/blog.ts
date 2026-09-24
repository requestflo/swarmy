/**
 * Blog posts. A stub for now: posts are plain data rendered by
 * routes/blog/$slug.tsx. When there are more than a handful, move them to a
 * second fumadocs collection (content/blog/*.mdx) like the docs.
 */
export interface BlogPost {
  slug: string;
  title: string;
  description: string;
  date: string; // ISO date
  author: string;
  body: string[]; // paragraphs
}

export const BLOG_POSTS: BlogPost[] = [
  {
    slug: 'hello-world',
    title: 'swarmy has a website',
    description: 'Docs, a feature list that says what is real, and an honest comparison.',
    date: '2026-09-24',
    author: 'The swarmy team',
    body: [
      'This site is new. It is built with TanStack Start, prerendered to static files, and deployed by swarmy itself from a swarmy.yaml in the repo — the same way you would deploy your own app.',
      'The docs live next to the code, as Markdown files in the swarmy repo. If a page is wrong, the "Edit on GitHub" link at the bottom of every docs page takes you straight to the file.',
      'We will write here about releases, design decisions and the occasional war story from running swarmy on real servers.',
    ],
  },
];
