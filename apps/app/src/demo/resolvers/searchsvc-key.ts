import type { SearchKeyRotateResult } from '@swarmy/core';
import type { DomainResolvers } from '../types';
import { instanceOf } from './searchsvc-indexes';

/**
 * Demo `search.rotateKey`: the instance moves to the next `…-key__v<n>`
 * secret, the engine and every attached app count as restarted, and a fresh
 * key comes back once (as search-key.service returns it).
 */
function demoKey(): string {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  return `demo-${Array.from({ length: 27 }, () => abc[Math.floor(Math.random() * abc.length)]).join('')}`;
}

export const searchsvcKey: DomainResolvers = {
  handlers: {
    'search.rotateKey': (i, s): SearchKeyRotateResult => {
      const v = instanceOf(s, i);
      const family = `swarmy-search-${v.stack}_${v.name}-key`;
      const m = /__v(\d+)$/.exec(v.keySecret);
      const version = (m ? Number(m[1]) : 1) + 1;
      v.keySecret = `${family}__v${version}`;
      return {
        stack: v.stack,
        name: v.name,
        keySecret: v.keySecret,
        version,
        masterKey: demoKey(),
        redeployed: [v.service, ...v.attachments.map((a) => `${v.stack}_${a.service}`)],
        failed: [],
      };
    },
  },
};
