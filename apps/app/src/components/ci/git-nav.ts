/**
 * Leaving the dashboard for a git provider. Absolute URLs are a real browser
 * navigation (GitHub / GitLab); a same-origin path (what demo mode hands
 * back) stays inside the SPA so the in-memory demo world survives.
 */
type NavigateHref = (opts: { href: string }) => unknown;

export function goToProvider(url: string, navigate: NavigateHref): void {
  if (url.startsWith('/')) {
    void navigate({ href: url });
    return;
  }
  window.location.assign(url);
}

/**
 * GitHub's App-manifest flow is a form POST with a single `manifest` field
 * (JSON). Build it off-screen and submit — the browser goes to GitHub, then
 * comes back through the controller to `/ci?git=…`.
 */
export function postGithubManifest(
  postUrl: string,
  manifest: string,
  navigate: NavigateHref,
): void {
  if (postUrl.startsWith('/')) {
    goToProvider(postUrl, navigate);
    return;
  }
  const form = document.createElement('form');
  form.method = 'post';
  form.action = postUrl;
  form.style.display = 'none';
  const field = document.createElement('input');
  field.type = 'hidden';
  field.name = 'manifest';
  field.value = manifest;
  form.appendChild(field);
  document.body.appendChild(form);
  form.submit();
}
