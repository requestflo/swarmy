import { describe, expect, it } from 'bun:test';
import { fromHeroku } from './from-heroku';
import { convertDomains, readHerokuDomains } from './from-heroku-domains';
import { parseAppConfig } from './parse';

const CLI = `=== acme-shop Heroku Domain
acme-shop-1a2b3c.herokuapp.com

=== acme-shop Custom Domains
Domain Name      DNS Record Type DNS Target                          SNI Endpoint
───────────────  ─────────────── ─────────────────────────────────── ────────────
www.acme.example CNAME           shiny-x-abc.herokudns.com           tokyo-1234
acme.example     ALIAS or ANAME  fuzzy-y-def.herokudns.com           tokyo-1234
`;

describe('Heroku domains → web’s domains', () => {
  it('reads `heroku domains`, a plain list or the API’s JSON', () => {
    expect(readHerokuDomains(CLI)).toEqual(['acme-shop-1a2b3c.herokuapp.com', 'www.acme.example', 'acme.example']);
    expect(readHerokuDomains('api.acme.example\n\nshop.acme.example.\n')).toEqual(['api.acme.example', 'shop.acme.example']);
    expect(readHerokuDomains('[{"hostname":"a.example","kind":"custom"},{"kind":"heroku"}]')).toEqual(['a.example']);
    expect(readHerokuDomains('[not json')).toEqual([]);
  });

  it('custom domains carry over; Heroku’s own name stays and says so; junk is listed', () => {
    const c = convertDomains(['WWW.Acme.Example', 'www.acme.example', 'acme-shop-1a2b3c.herokuapp.com', '*.acme.example', 'not a host']);
    expect(c.domains).toEqual(['www.acme.example', '*.acme.example']);
    expect(c.gaps.map((g) => [g.key, Boolean(g.handled)])).toEqual([
      ['domains: acme-shop-1a2b3c.herokuapp.com', true],
      ['domains: not a host', false],
    ]);
    expect(c.changes[0]).toContain('Heroku keeps serving them until then');
  });

  it('lands on services.web.domains in a swarmy.yaml the parser accepts', () => {
    const r = fromHeroku({ procfile: 'web: node server.js', domains: readHerokuDomains(CLI), app: 'acme' });
    const cfg = parseAppConfig(r.yaml!).config!;
    expect(cfg.services.web!.domains).toEqual(['www.acme.example', 'acme.example']);
    expect(r.domains).toEqual(['www.acme.example', 'acme.example']);
  });
});
