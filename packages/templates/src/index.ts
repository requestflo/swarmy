/**
 * @swarmy/templates — the one-click app catalogue. Each entry is a swarmy.yaml
 * (v1) plus a metadata header; see `types.ts` for the authoring rules. PURE and
 * browser-safe: the controller compiles templates into blueprint plans, the
 * dashboard's demo mode reads the same catalogue.
 */
export * from './types';
export * from './render';
export { APP_TEMPLATES } from './catalog';
export { END_USER_AUTH_APP_SNIPPET, END_USER_AUTH_EXAMPLE, PROTECT_MY_APP_EXAMPLE } from './examples/app-auth';
import { APP_TEMPLATES } from './catalog';
import type { AppTemplate } from './types';

export function findAppTemplate(id: string): AppTemplate | undefined {
  return APP_TEMPLATES.find((t) => t.id === id);
}
