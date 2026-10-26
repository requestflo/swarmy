import { closestAppPathRule, decideAppPath, ruleKey, type AppPathRule } from '@swarmy/core';
import type { AppAccessPerson, AppAccessRoute } from './types';

/**
 * Per-path who-can-enter in words, decided by the SAME pure matcher the edge
 * check uses (`@swarmy/core` app-access-paths), so the simulator and the
 * Access tab never disagree with forward-auth.
 */

/** A rule's path as people read it: `/admin` for `/admin/*`. */
export function rulePath(rule: Pick<AppPathRule, 'path'>): string {
  return ruleKey(rule.path) ?? rule.path;
}

/** Who a rule lets in, in a phrase: "group sre and Ada Lovelace", "nobody". */
export function ruleWho(rule: AppPathRule, people: readonly AppAccessPerson[]): string {
  if (rule.everyone) return 'everyone the app lets in';
  const parts: string[] = [];
  const roles = rule.roles ?? [];
  if (roles.includes('owner') && roles.includes('admin')) parts.push('owners and admins');
  else for (const r of roles) parts.push(`${r}s`);
  for (const g of rule.groups ?? []) parts.push(`group ${g}`);
  for (const id of rule.people ?? []) {
    const p = people.find((x) => x.memberId === id);
    parts.push(p?.name ?? p?.email ?? 'a named person');
  }
  if (parts.length === 0) return 'nobody';
  return parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** The address's path rules in a short clause for its Summary row: " /admin: group sre only." */
export function pathRulesLine(route: AppAccessRoute, people: readonly AppAccessPerson[]): string {
  if (route.pathRulesError) return " Its path rules can't be read, so nobody gets in.";
  return route.pathRules
    .filter((r) => !r.everyone)
    .map((r) => ` ${rulePath(r)}: ${ruleWho(r, people)} only.`)
    .join('');
}

/** Every address worth picking in the simulator: each route, and each rule path under it. */
export function addressOptions(routes: readonly AppAccessRoute[]): { key: string; route: AppAccessRoute; path: string; label: string }[] {
  const out: { key: string; route: AppAccessRoute; path: string; label: string }[] = [];
  for (const r of routes) {
    const paths = [r.path, ...r.pathRules.map(rulePath).filter((p) => p !== r.path)];
    for (const path of paths) out.push({ key: `${r.id}|${path}`, route: r, path, label: path === '/' ? r.host : `${r.host}${path}` });
  }
  return out;
}

/** Can this member (already let into the app) open `path`? Mirrors forward-auth. */
export function canEnterPath(route: AppAccessRoute, person: AppAccessPerson, path: string): boolean {
  if (!person.canEnter) return false;
  if (route.pathRulesError) return false;
  return decideAppPath(route.pathRules.length ? route.pathRules : undefined, path, person).admit;
}

/** The rule that decides `path`, if any. */
export function ruleFor(route: AppAccessRoute, path: string): AppPathRule | null {
  return closestAppPathRule(route.pathRules, path.toLowerCase());
}
