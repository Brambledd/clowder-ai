/**
 * POST /api/evidence/forget — targeted unlearning endpoint.
 *
 * Backs the cat_cafe_forget_evidence MCP tool. Deletion is physical
 * (deleteByAnchor removes the store row and its FTS entry); file-sourced
 * docs additionally get their frontmatter rewritten to status: retired so
 * a full rescan re-indexes them only at the demoted rank.
 *
 * Default evidenceScope is 'threads' (conversation memory). Forgetting
 * 'docs' (project knowledge: ADRs, feature specs) is opt-in because it is
 * destructive to shared team context.
 */

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { ForgetRequest } from '../domains/memory/forget/ForgetService.js';
import { ForgetService } from '../domains/memory/forget/ForgetService.js';

const forgetBodySchema = z
  .object({
    scope: z.enum(['facts', 'topic', 'timerange']),
    evidenceScope: z.enum(['threads', 'docs', 'all']).default('threads'),
    targets: z.array(z.string().min(1)).max(12).optional(),
    since: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    until: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    replacement: z.string().max(2000).optional(),
  })
  .superRefine((body, ctx) => {
    if (body.scope !== 'timerange' && (!body.targets || body.targets.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'targets is required for facts and topic scopes',
      });
    }
    if (body.scope === 'timerange' && !body.since && !body.until) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'since or until is required for timerange scope',
      });
    }
  });

type InjectedServices = {
  /** Pre-wired ForgetService (store + cascade callbacks). */
  forgetService: ForgetService;
};

export const evidenceForgetRoutes: FastifyPluginAsync<InjectedServices> = async (app, opts) => {
  app.post<{ Body: z.infer<typeof forgetBodySchema> }>(
    '/api/evidence/forget',
    {
      schema: {
        body: {
          type: 'object',
          required: ['scope'],
          properties: {
            scope: { type: 'string', enum: ['facts', 'topic', 'timerange'] },
            evidenceScope: { type: 'string', enum: ['threads', 'docs', 'all'] },
            targets: { type: 'array', items: { type: 'string' }, maxItems: 12 },
            since: { type: 'string' },
            until: { type: 'string' },
            replacement: { type: 'string', maxLength: 2000 },
          },
        },
      },
    },
    async (request, reply) => {
      const parsed = forgetBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'validation_failed',
          issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
        });
      }
      const body = parsed.data;
      const forgetRequest: ForgetRequest = {
        scope: body.scope,
        evidenceScope: body.evidenceScope,
        targets: body.targets,
        since: body.since,
        until: body.until,
        replacement: body.replacement,
      };
      try {
        const result = await opts.forgetService.execute(forgetRequest);
        return reply.send(result);
      } catch (error) {
        request.log.error({ err: error }, 'evidence-forget: execution failed');
        return reply.status(500).send({ error: 'forget_execution_failed' });
      }
    },
  );
};
