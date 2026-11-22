import type { CreatorHubClient } from '@qiu-creator/api-client';
import type {
  AiConcreteLanguage,
  AiModelChoice,
  AiModelsResponse,
  AiOutputLanguage,
  AiPreferences,
  AiTaskKind,
  CreatePromptRequest,
  Prompt,
  PromptScene,
} from '@qiu-creator/contracts';
import { createContext, useContext, useSyncExternalStore } from 'react';
import { currentLocale } from './i18n.js';

/**
 * The AI choices shared by the whole app (QC-075, PT-20261122-003): the
 * output language and the model last used per task (global preferences kept
 * on the Mac, so every device sees the same), the models that can be switched
 * to, and the prompt library. The toolbar, the side panel and the Prompt page
 * read and change the same store, so a change in one shows in the others.
 */

export interface AiLibraryState {
  prompts: Prompt[] | null;
  preferences: AiPreferences | null;
  /** Chat models of ready providers; null until first asked for. */
  models: AiModelsResponse | null;
  /** The prompt list could not be read. */
  failed: boolean;
}

const EMPTY: AiLibraryState = { prompts: null, preferences: null, models: null, failed: false };

export class AiLibrary {
  private state: AiLibraryState = EMPTY;
  private readonly listeners = new Set<() => void>();
  private promptsRequest = 0;
  private modelsRequest: Promise<void> | null = null;

  constructor(readonly client: CreatorHubClient) {}

  getSnapshot = (): AiLibraryState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(patch: Partial<AiLibraryState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  /** Preferences and prompts; models wait until a model menu opens. */
  async load(): Promise<void> {
    await Promise.all([this.loadPreferences(), this.loadPrompts()]);
  }

  async loadPreferences(): Promise<void> {
    try {
      this.set({ preferences: await this.client.ai.preferences() });
    } catch {
      // Keep what we had; the menus fall back to 跟隨原文 and the provider default.
    }
  }

  async loadPrompts(): Promise<void> {
    const n = ++this.promptsRequest;
    try {
      const list = await this.client.ai.prompts.list();
      if (n === this.promptsRequest) this.set({ prompts: list.items, failed: false });
    } catch {
      if (n === this.promptsRequest) this.set({ failed: true });
    }
  }

  /** The switchable models; asked for again when `refresh` (a menu opened). */
  loadModels(refresh = false): Promise<void> {
    if (this.modelsRequest !== null && !refresh) return this.modelsRequest;
    const request = this.client.ai
      .models('chat')
      .then((models) => {
        this.set({ models });
      })
      .catch(() => {
        if (this.state.models === null) this.set({ models: { items: [], errors: [] } });
      });
    this.modelsRequest = request;
    return request;
  }

  /** Change the global output language (saved at once, shared by every device). */
  async setLanguage(language: AiOutputLanguage): Promise<void> {
    const before = this.state.preferences;
    if (before !== null) this.set({ preferences: { ...before, output_language: language } });
    try {
      this.set({
        preferences: await this.client.ai.patchPreferences({ output_language: language }),
      });
    } catch (e) {
      this.set({ preferences: before });
      throw e;
    }
  }

  /** Remember the model picked for a task (the toolbar and the panel share it). */
  async setModel(task: AiTaskKind, choice: AiModelChoice): Promise<void> {
    const before = this.state.preferences;
    if (before !== null)
      this.set({
        preferences: { ...before, last_models: { ...before.last_models, [task]: choice } },
      });
    try {
      this.set({
        preferences: await this.client.ai.patchPreferences({ last_models: { [task]: choice } }),
      });
    } catch (e) {
      this.set({ preferences: before });
      throw e;
    }
  }

  async createPrompt(input: CreatePromptRequest): Promise<Prompt> {
    const created = await this.client.ai.prompts.create(input);
    await this.loadPrompts();
    return created;
  }

  find(id: string | null): Prompt | null {
    if (id === null) return null;
    return this.state.prompts?.find((p) => p.id === id) ?? null;
  }
}

export const AiLibraryContext = createContext<AiLibrary | null>(null);

const NO_STATE = () => EMPTY;
const NO_SUBSCRIBE = () => () => undefined;

/** The shared store and its state (an empty state while not connected). */
export function useAiLibrary(): { library: AiLibrary | null; state: AiLibraryState } {
  const library = useContext(AiLibraryContext);
  const state = useSyncExternalStore(
    library?.subscribe ?? NO_SUBSCRIBE,
    library?.getSnapshot ?? NO_STATE,
  );
  return { library, state };
}

/** The interface language, sent so `follow` has something to fall back on. */
export function interfaceLanguage(): AiConcreteLanguage {
  const l = currentLocale();
  return l === 'zh-Hans' ? 'zh-Hans' : l === 'en' ? 'en' : 'zh-Hant';
}

/** The model a task uses now: the remembered one, or null for the provider's default. */
export function currentModel(state: AiLibraryState, task: AiTaskKind): AiModelChoice | null {
  return state.preferences?.last_models[task] ?? null;
}

export interface PickerEntry {
  prompt: Prompt;
  /** Not for this scene: shown dimmed and disabled, never hidden. */
  disabled: boolean;
  /** Used before: listed first. */
  recent: boolean;
}

/** How many recently used prompts go to the top of the picker. */
export const RECENT_PROMPTS = 3;

/**
 * The toolbar's prompt picker (⌘K): matching prompts, recently used first,
 * then the ones for this scene in library order, then the rest dimmed.
 */
export function pickerEntries(
  prompts: readonly Prompt[],
  scene: PromptScene,
  query: string,
  matches: (text: string, query: string) => boolean,
): PickerEntry[] {
  const q = query.trim();
  const found = prompts.filter(
    (p) => q === '' || matches(p.name, q) || (p.group !== null && matches(p.group, q)),
  );
  const usable = (p: Prompt) => p.scene === scene;
  const recentIds = new Set(
    found
      .filter((p) => usable(p) && p.last_used_at !== null)
      .sort((a, b) => (b.last_used_at ?? '').localeCompare(a.last_used_at ?? ''))
      .slice(0, RECENT_PROMPTS)
      .map((p) => p.id),
  );
  const recent = found
    .filter((p) => recentIds.has(p.id))
    .sort((a, b) => (b.last_used_at ?? '').localeCompare(a.last_used_at ?? ''));
  const rest = found.filter((p) => !recentIds.has(p.id) && usable(p));
  const other = found.filter((p) => !usable(p));
  return [
    ...recent.map((prompt) => ({ prompt, disabled: false, recent: true })),
    ...rest.map((prompt) => ({ prompt, disabled: false, recent: false })),
    ...other.map((prompt) => ({ prompt, disabled: true, recent: false })),
  ];
}
