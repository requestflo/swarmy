import type { StatusPageComponent, StatusPageView } from '@swarmy/core';

/** Local form state for the create/edit dialog. */
export interface PageDraft {
  title: string;
  slug: string;
  /** Once the user edits the slug by hand we stop deriving it from the title. */
  slugTouched: boolean;
  domain: string;
  components: StatusPageComponent[];
  showUptime: boolean;
  showIncidents: boolean;
}

export const EMPTY_DRAFT: PageDraft = {
  title: '',
  slug: '',
  slugTouched: false,
  domain: '',
  components: [],
  showUptime: true,
  showIncidents: true,
};

export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Title → kebab slug suggestion ("RequestFlo Status" → "requestflo-status"). */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
}

export function draftFromPage(page: StatusPageView): PageDraft {
  return {
    title: page.title,
    slug: page.slug,
    slugTouched: true,
    domain: page.domain ?? '',
    components: page.components.map((c) => ({ ...c })),
    showUptime: page.showUptime,
    showIncidents: page.showIncidents,
  };
}

export function draftReady(draft: PageDraft): boolean {
  return (
    draft.title.trim().length > 0 &&
    draft.slug.length >= 3 &&
    SLUG_RE.test(draft.slug) &&
    (draft.domain.trim() === '' || draft.domain.includes('.'))
  );
}
