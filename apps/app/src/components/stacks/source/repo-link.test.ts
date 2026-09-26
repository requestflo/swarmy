import { describe, expect, it } from 'bun:test';
import { repoFileUrl } from './repo-link';

describe('repoFileUrl', () => {
  it('links GitHub-style https and ssh clone URLs to the file', () => {
    expect(repoFileUrl('https://github.com/northwind/storefront.git', 'main', 'swarmy.yaml')).toBe(
      'https://github.com/northwind/storefront/blob/main/swarmy.yaml',
    );
    expect(repoFileUrl('git@github.com:northwind/storefront.git', 'feature/x', './deploy/swarmy.yaml')).toBe(
      'https://github.com/northwind/storefront/blob/feature/x/deploy/swarmy.yaml',
    );
  });

  it('uses /-/blob/ on GitLab and drops credentials', () => {
    expect(repoFileUrl('https://oauth2:tok@gitlab.com/acme/shop.git', 'main', 'swarmy.yaml')).toBe(
      'https://gitlab.com/acme/shop/-/blob/main/swarmy.yaml',
    );
  });

  it('gives up on URLs with no web page', () => {
    expect(repoFileUrl('/srv/git/shop.git', 'main', 'swarmy.yaml')).toBeNull();
  });
});
