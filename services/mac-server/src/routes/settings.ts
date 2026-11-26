import {
  ErrorResponseSchema,
  PutTextScriptSettingRequestSchema,
  TextScriptSettingSchema,
} from '@qiu-creator/contracts';
import type { App } from '../http/app-type.js';
import type { TextScriptService } from '../works/text-script-service.js';

const errors = { 400: ErrorResponseSchema, 401: ErrorResponseSchema, 403: ErrorResponseSchema };

/** App settings stored on the Mac (QC-103: 作品文字字體). */
export function registerSettingsRoutes(app: App, textScripts: TextScriptService): void {
  app.get(
    '/api/v1/settings/text-script',
    {
      schema: {
        description:
          '作品文字字體 (QC-103): the script (`zh-Hans`, the default, or `zh-Hant`) that text agent tokens write into works is converted to, unless a project overrides it (`text_script` on the project). `updated_at` is null while it is the default.',
        response: { 200: TextScriptSettingSchema, ...errors },
      },
    },
    () => textScripts.setting(),
  );

  app.put(
    '/api/v1/settings/text-script',
    {
      schema: {
        description:
          'Set the global 作品文字字體 (owner only). Applies to text agents write from now on; existing works and the owner’s own writes are never converted.',
        body: PutTextScriptSettingRequestSchema,
        response: { 200: TextScriptSettingSchema, ...errors },
      },
    },
    (req) => textScripts.setSetting(req.body),
  );
}
