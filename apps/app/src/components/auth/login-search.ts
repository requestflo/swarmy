export interface LoginSearch {
  /** Where a session loss ejected the user from; same-origin paths only. */
  redirect?: string;
  /** Organization invitation id from an invite link — accepted after auth. */
  invite?: string;
  /** An org SSO provider id to start right away (the SSO admin's test link). */
  sso?: string;
}

/** `/login` search params, validated: anything off-shape is dropped. */
export function validateLoginSearch(search: Record<string, unknown>): LoginSearch {
  const out: LoginSearch = {};
  const r = search.redirect;
  if (typeof r === 'string' && r.startsWith('/') && !r.startsWith('//') && !r.includes('\\')) out.redirect = r;
  const i = search.invite;
  if (typeof i === 'string' && /^[\w-]{1,128}$/.test(i)) out.invite = i;
  const s = search.sso;
  if (typeof s === 'string' && /^[a-z0-9-]{2,40}$/.test(s)) out.sso = s;
  return out;
}
