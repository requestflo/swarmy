import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts', client: 'src/client.ts', server: 'src/server.ts' },
  format: ['esm'],
  dts: true,
  clean: true,
  external: ['@swarmy/db', 'better-auth'],
});
