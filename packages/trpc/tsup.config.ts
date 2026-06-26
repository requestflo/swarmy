import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  dts: true,
  clean: true,
  external: [
    '@swarmy/core',
    '@swarmy/db',
    '@swarmy/auth',
    '@swarmy/ingress',
    '@trpc/server',
    'superjson',
    'yaml',
    'zod',
  ],
});
