import {
  AiModelsQuerySchema,
  AiModelsResponseSchema,
  AiPreferencesSchema,
  CreatePromptRequestSchema,
  ErrorResponseSchema,
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENT_REPLAYED_HEADER,
  PatchAiPreferencesRequestSchema,
  PatchPromptRequestSchema,
  PromptExportSchema,
  PromptImportResponseSchema,
  PromptListResponseSchema,
  PromptParamsSchema,
  PromptPreviewRequestSchema,
  PromptPreviewResponseSchema,
  PromptSchema,
  ReorderPromptsRequestSchema,
  RevisionConflictResponseSchema,
  SuggestPromptRequestSchema,
  WorkAiJobResponseSchema,
} from '@qiu-creator/contracts';
import { z } from 'zod';
import type { AiService } from '../ai/ai-service.js';
import type { PromptService } from '../ai/prompt-service.js';
import { requirePrincipal } from '../auth/token-service.js';
import type { App } from '../http/app-type.js';
import type { IdempotencyService } from '../idempotency/idempotency-service.js';

const errorResponses = {
  400: ErrorResponseSchema,
  401: ErrorResponseSchema,
  403: ErrorResponseSchema,
  404: ErrorResponseSchema,
};

/**
 * Output language, remembered models and the prompt library (QC-075). Under
 * `/api/v1/ai/`, so owner token only, reads included.
 */
export function registerAiPromptRoutes(
  app: App,
  prompts: PromptService,
  ai: AiService,
  idempotency: IdempotencyService,
): void {
  app.get(
    '/api/v1/ai/preferences',
    {
      schema: {
        description:
          'Output language for AI text (`auto` = same as the source) and the model last used per task. Shared by every device.',
        response: { 200: AiPreferencesSchema, ...errorResponses },
      },
    },
    () => ai.preferences(),
  );

  app.patch(
    '/api/v1/ai/preferences',
    {
      schema: {
        description:
          'Change the output language and/or remembered models; `last_models` is merged (null clears one).',
        body: PatchAiPreferencesRequestSchema,
        response: { 200: AiPreferencesSchema, ...errorResponses },
      },
    },
    (req) => ai.patchPreferences(req.body),
  );

  app.get(
    '/api/v1/ai/models',
    {
      schema: {
        description:
          'Models to switch between in the toolbar, across ready providers (key stored, notice confirmed). New API: its relay list (cached, QC-054); the others: their configured text model.',
        querystring: AiModelsQuerySchema,
        response: { 200: AiModelsResponseSchema, ...errorResponses },
      },
    },
    async (req) => {
      await ai.loadNewApiBaseUrl();
      return ai.switchableModels(req.query.kind);
    },
  );

  app.get(
    '/api/v1/ai/prompts',
    {
      schema: {
        description: 'Built-in prompts (read-only) first, then the custom ones in their order.',
        response: { 200: PromptListResponseSchema, ...errorResponses },
      },
    },
    () => ({ items: prompts.list() }),
  );

  app.post(
    '/api/v1/ai/prompts',
    {
      schema: {
        description: 'Add a custom prompt at the end.',
        body: CreatePromptRequestSchema,
        response: { 201: PromptSchema, ...errorResponses },
      },
    },
    (req, reply) => {
      reply.code(201);
      return prompts.create(req.body);
    },
  );

  app.get(
    '/api/v1/ai/prompts/export',
    {
      schema: {
        description: 'Custom prompts as a JSON file (`{ version: 1, prompts }`, no usage counts).',
        response: { 200: PromptExportSchema, ...errorResponses },
      },
    },
    (_req, reply) => {
      reply.header('content-disposition', 'attachment; filename="prompts.json"');
      return prompts.exportAll();
    },
  );

  app.post(
    '/api/v1/ai/prompts/import',
    {
      schema: {
        description:
          'Add the prompts of an export file at the end (at most 500); a name already in use is imported as 「…（副本）」.',
        body: PromptExportSchema,
        response: { 200: PromptImportResponseSchema, ...errorResponses },
      },
    },
    (req) => prompts.import(req.body),
  );

  app.put(
    '/api/v1/ai/prompts/order',
    {
      schema: {
        description: 'Reorder the custom prompts: list every one exactly once.',
        body: ReorderPromptsRequestSchema,
        response: { 200: PromptListResponseSchema, ...errorResponses },
      },
    },
    (req) => ({ items: prompts.reorder(req.body) }),
  );

  app.post(
    '/api/v1/ai/prompts/preview',
    {
      schema: {
        description:
          'Expand a prompt’s variables (`{選取}`, `{標題}`, `{全文}`, `{平台}`, `{語言}`) against a work, as a job would, and say which language it would use. Sends nothing.',
        body: PromptPreviewRequestSchema,
        response: { 200: PromptPreviewResponseSchema, ...errorResponses },
      },
    },
    (req) => prompts.preview(req.body),
  );

  app.post(
    '/api/v1/ai/prompt-suggestions',
    {
      schema: {
        description:
          'Queue an AI draft of a new prompt, or a rewrite of `base_prompt_id`. The result (`PromptSuggestionResult`) is a candidate only: keep it with `POST /prompts` or `PATCH /prompts/:id` and `base_revision`. Supports `Idempotency-Key`.',
        body: SuggestPromptRequestSchema,
        response: {
          202: WorkAiJobResponseSchema,
          409: ErrorResponseSchema,
          422: ErrorResponseSchema,
          ...errorResponses,
        },
      },
    },
    (req, reply) => {
      reply.code(202);
      const result = idempotency.run(
        requirePrincipal(req.principal),
        'POST /api/v1/ai/prompt-suggestions',
        req.headers[IDEMPOTENCY_KEY_HEADER],
        req.body,
        () => ({ statusCode: 202, body: prompts.suggest(req.body) }),
      );
      const body = WorkAiJobResponseSchema.parse(result.body);
      if (!result.replayed) return body;
      reply.header(IDEMPOTENT_REPLAYED_HEADER, 'true');
      return { ...body, job: ai.get(body.job.id) };
    },
  );

  app.patch(
    '/api/v1/ai/prompts/:id',
    {
      schema: {
        description:
          'Edit a custom prompt. Requires `base_revision` or `If-Match`: 428 without, 409 `revision_conflict` when stale. Built-ins: 403.',
        params: PromptParamsSchema,
        body: PatchPromptRequestSchema,
        response: {
          200: PromptSchema,
          409: z.union([RevisionConflictResponseSchema, ErrorResponseSchema]),
          428: ErrorResponseSchema,
          ...errorResponses,
        },
      },
    },
    (req, reply) => {
      const prompt = prompts.patch(req.params.id, req.body, req.headers['if-match']);
      reply.header('etag', `"${String(prompt.revision)}"`);
      return prompt;
    },
  );

  app.delete(
    '/api/v1/ai/prompts/:id',
    {
      schema: {
        description: 'Delete a custom prompt. Built-ins: 403.',
        params: PromptParamsSchema,
        response: { 204: z.null(), ...errorResponses },
      },
    },
    (req, reply) => {
      prompts.delete(req.params.id);
      reply.code(204);
      return null;
    },
  );

  app.post(
    '/api/v1/ai/prompts/:id/duplicate',
    {
      schema: {
        description: 'Copy a prompt (built-ins too) into a new custom prompt named 「…（副本）」.',
        params: PromptParamsSchema,
        response: { 201: PromptSchema, ...errorResponses },
      },
    },
    (req, reply) => {
      reply.code(201);
      return prompts.duplicate(req.params.id);
    },
  );
}
