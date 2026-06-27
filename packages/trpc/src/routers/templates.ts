import { z } from 'zod';
import { adminProcedure, orgProcedure, router } from '../trpc';
import {
  deployTemplate,
  getTemplate,
  listTemplates,
  renderTemplate,
  type TemplateId,
} from '../services/templates';
import { notFound } from '../errors';

const templateIdEnum = z.enum(['postgres-ha', 'redis-ha']);

const paramsSchema = z.object({
  name: z
    .string()
    .min(1)
    .regex(/^[a-z][a-z0-9-]*$/, 'lowercase letters, digits and dashes only'),
  regions: z.array(z.string().min(1)).default([]),
  image: z.string().optional(),
  replicasPerRegion: z.number().int().min(1).max(5).optional(),
});

export const templatesRouter = router({
  /** Gallery: ready-made HA templates (no render — metadata only). */
  list: orgProcedure.query(() => listTemplates()),

  get: orgProcedure
    .input(z.object({ id: templateIdEnum }))
    .query(({ input }) => {
      const tpl = getTemplate(input.id as TemplateId);
      if (!tpl) throw notFound('template', input.id);
      const { render: _render, ...meta } = tpl;
      return meta;
    }),

  /** Pure preview of the rendered services + portable compose for a template. */
  preview: orgProcedure
    .input(z.object({ id: templateIdEnum, params: paramsSchema }))
    .query(({ input }) => {
      const rendered = renderTemplate(input.id as TemplateId, input.params);
      if (!rendered) throw notFound('template', input.id);
      return rendered;
    }),

  /** Deploy an HA template across regions + optionally wire Geo-DNS records. */
  deploy: adminProcedure
    .input(
      z.object({
        id: templateIdEnum,
        params: paramsSchema,
        geo: z
          .object({
            host: z.string().min(1),
            targets: z.record(z.string()).optional(),
          })
          .optional(),
      }),
    )
    .mutation(({ ctx, input }) =>
      deployTemplate(ctx, { id: input.id as TemplateId, params: input.params, geo: input.geo }),
    ),
});
