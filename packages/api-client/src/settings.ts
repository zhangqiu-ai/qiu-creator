import {
  TextScriptSettingSchema,
  type PutTextScriptSettingRequest,
  type TextScriptSetting,
} from '@qiu-creator/contracts';
import { call, type Ctx } from './imports.js';

/** Settings stored on the Mac (QC-103). */
export interface CreatorHubSettingsApi {
  /** 作品文字字體: the global script agent text is converted to. */
  textScript(): Promise<TextScriptSetting>;
  /** Owner only: change it. Existing works are never converted. */
  setTextScript(input: PutTextScriptSettingRequest): Promise<TextScriptSetting>;
}

export function createSettingsApi(ctx: Ctx): CreatorHubSettingsApi {
  return {
    textScript: () => call(ctx, TextScriptSettingSchema, 'GET', '/api/v1/settings/text-script'),
    setTextScript: (input) =>
      call(ctx, TextScriptSettingSchema, 'PUT', '/api/v1/settings/text-script', input),
  };
}
