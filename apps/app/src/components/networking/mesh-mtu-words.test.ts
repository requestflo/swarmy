import { describe, expect, it } from 'bun:test';
import { checkOverlayMtu } from '@swarmy/core';
import { mtuAllSteps, mtuFixLine, mtuLede, mtuRowSub, type MtuViewLike } from './mesh-mtu-words';

// The board's case through the real check: wt0 1280, overlays at Docker's default.
const check = checkOverlayMtu({
  iface: 'wt0',
  linkMtu: 1280,
  overlays: [
    { name: 'shop_default', encrypted: false, attachable: true, managed: true, ingress: false, stack: 'shop' },
    { name: 'vault', encrypted: true, attachable: false, managed: false, ingress: false },
    { name: 'swarmy', mtu: 1280, encrypted: true, attachable: true, managed: true, ingress: false },
  ],
});
const view: MtuViewLike = { ...check, services: { shop_default: ['shop_api', 'shop_web'], vault: ['vault_kv'] } };

describe('"Networks are too big for the mesh" words', () => {
  it('says what is true, with the numbers', () => {
    expect(mtuLede(view)).toBe(
      'The private network carries packets of up to 1280 bytes. 2 networks send up to 1450, so large transfers between servers can stall while small ones still work.',
    );
    expect(mtuFixLine(view)).toBe('Fix: set them to 1230 (1204 encrypted). Networks swarmy creates from now on already fit.');
  });

  it('one plain network reads in the singular, with no encrypted clause', () => {
    const one = { ...view, tooBig: view.tooBig.filter((f) => f.name === 'shop_default') };
    expect(mtuLede(one)).toContain('1 network sends up to 1450');
    expect(mtuFixLine(one)).toBe('Fix: set it to 1230. Networks swarmy creates from now on already fit.');
  });

  it('row subtitles name what a recreate takes offline', () => {
    const f = view.tooBig[0]!;
    expect(mtuRowSub(f, ['a', 'b'])).toBe('a, b');
    expect(mtuRowSub(f, ['a', 'b', 'c', 'd', 'e'])).toBe('a, b, c +2');
    expect(mtuRowSub(f, [])).toBe('nothing on it right now');
    expect(mtuRowSub({ ...f, ingress: true }, ['a'])).toBe("Docker's network for published ports");
  });

  it('the manual steps are real Docker commands; a swarmy app is deployed again, others re-attached', () => {
    expect(mtuAllSteps(view)).toBe(
      [
        '# shop_default: 1450 now, fits at 1230',
        'docker service update --network-rm shop_default shop_api',
        'docker service update --network-rm shop_default shop_web',
        'docker network rm shop_default',
        'docker network create --driver overlay --attachable --opt com.docker.network.driver.mtu=1280 --label swarmy.managed=true --label com.docker.stack.namespace=shop shop_default',
        '# then deploy shop again in swarmy: it re-attaches its services with their short names',
        '',
        '# vault: 1424 now, fits at 1204',
        'docker service update --network-rm vault vault_kv',
        'docker network rm vault',
        'docker network create --driver overlay --opt encrypted --opt com.docker.network.driver.mtu=1280 vault',
        'docker service update --network-add vault vault_kv',
      ].join('\n'),
    );
  });
});
