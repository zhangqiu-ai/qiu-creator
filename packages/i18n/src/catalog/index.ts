import type { CatalogArea } from '../define.js';
import { ai } from './ai.js';
import { aiServices } from './aiServices.js';
import { assets } from './assets.js';
import { common } from './common.js';
import { editor } from './editor.js';
import { errors } from './errors.js';
import { format } from './format.js';
import { imagePost } from './imagePost.js';
import { library } from './library.js';
import { main } from './main.js';
import { modelPicker } from './modelPicker.js';
import { projects } from './projects.js';
import { prompts } from './prompts.js';
import { serviceSettings } from './serviceSettings.js';
import { settings } from './settings.js';
import { settingsPages } from './settingsPages.js';
import { shell } from './shell.js';
import { tabs } from './tabs.js';
import { videoWork } from './videoWork.js';
import { workActions } from './workActions.js';

/**
 * All messages by area. Each area is its own file so pages can be translated
 * independently; keys are `area.key` (e.g. `common.cancel`).
 */
export const catalog = {
  common,
  errors,
  shell,
  settings,
  main,
  format,
  assets,
  ai,
  serviceSettings,
  editor,
  library,
  tabs,
  imagePost,
  videoWork,
  workActions,
  modelPicker,
  aiServices,
  settingsPages,
  projects,
  prompts,
} as const;

type Areas = typeof catalog;
type AreaKey<A> = A extends CatalogArea<infer K> ? K : never;

/** Every message key, e.g. `'common.cancel' | 'shell.library' | …`. */
export type MessageKey = {
  [A in keyof Areas]: `${A}.${AreaKey<Areas[A]>}`;
}[keyof Areas];
