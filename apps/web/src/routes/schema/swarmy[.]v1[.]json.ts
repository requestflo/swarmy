import { createFileRoute } from '@tanstack/react-router';
import { SWARMY_YAML_JSON_SCHEMA } from '@swarmy/app-config';

/**
 * The swarmy.yaml v1 JSON Schema, served at the URL the docs (and the
 * dashboard's starter file) put in `# yaml-language-server: $schema=…`, so
 * editors validate and autocomplete swarmy.yaml. Prerendered from
 * @swarmy/app-config, which keeps it in step with the Zod schema.
 */
export const Route = createFileRoute('/schema/swarmy.v1.json')({
  server: {
    handlers: {
      GET: async () =>
        new Response(JSON.stringify(SWARMY_YAML_JSON_SCHEMA, null, 2), {
          headers: { 'Content-Type': 'application/schema+json; charset=utf-8' },
        }),
    },
  },
});
