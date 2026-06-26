import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'protocol/index': 'src/protocol/index.ts',
    inputs: 'src/inputs.ts',
    views: 'src/views.ts',
    docker: 'src/docker.ts',
  },
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  external: ['dockerode'],
});
