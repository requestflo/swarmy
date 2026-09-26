import type { StatusComponentOption, StatusPageComponent } from '@swarmy/core';

/** The mono source line under a component: where its status comes from. */
export function componentSource(c: Pick<StatusPageComponent, 'kind' | 'ref'>, option?: StatusComponentOption): string {
  const stack = option?.hint?.startsWith('stack ') ? option.hint.slice('stack '.length) : null;
  switch (c.kind) {
    case 'service':
      return `${stack ? `${stack} / ` : ''}${c.ref} · health`;
    case 'db':
      return `${c.ref} · database health`;
    case 'cache':
      return `${c.ref} · cache health`;
    case 'region':
      return `region ${c.ref} · servers online`;
    case 'ingress':
      return 'front door · health';
  }
}
