import type { AiProvider } from '@qiu-creator/contracts';

/**
 * Where AI provider API keys live. Keys are write-only from the API's point
 * of view: they are read only by the job runner, right before a provider
 * call, and never returned, logged or stored in SQLite.
 */
export interface SecretStore {
  get(provider: AiProvider): Promise<string | null>;
  set(provider: AiProvider, value: string): Promise<void>;
  /** Returns whether a key was removed. */
  delete(provider: AiProvider): Promise<boolean>;
}

/** In-memory store for tests and development; nothing is persisted. */
export class MemorySecretStore implements SecretStore {
  private readonly values = new Map<AiProvider, string>();

  get(provider: AiProvider): Promise<string | null> {
    return Promise.resolve(this.values.get(provider) ?? null);
  }

  set(provider: AiProvider, value: string): Promise<void> {
    this.values.set(provider, value);
    return Promise.resolve();
  }

  delete(provider: AiProvider): Promise<boolean> {
    return Promise.resolve(this.values.delete(provider));
  }
}

export const KEYCHAIN_SERVICE = 'com.qiu-creator.creatorhub.ai';

/** Minimal shape of `@napi-rs/keyring`'s `Entry` that this store uses. */
interface KeyringEntry {
  getPassword(): string | null | undefined;
  setPassword(password: string): void;
  deletePassword(): boolean;
}

/**
 * macOS Keychain via `@napi-rs/keyring` (Security framework, in process).
 * Secrets never pass through a command line, unlike `security add-generic-password -w`.
 * One generic-password item per provider: service `com.qiu-creator.creatorhub.ai`,
 * account = provider id.
 *
 * Under the test runner every access throws, so a test can never touch the
 * real Keychain. Construction is allowed: servers built in other packages'
 * tests get this default but never reach it unless they store a key.
 */
export class KeychainSecretStore implements SecretStore {
  constructor(private readonly service: string = KEYCHAIN_SERVICE) {}

  async get(provider: AiProvider): Promise<string | null> {
    const entry = await this.entry(provider);
    try {
      return entry.getPassword() ?? null;
    } catch {
      // No such item (or the Keychain is locked): treated as "no key".
      return null;
    }
  }

  async set(provider: AiProvider, value: string): Promise<void> {
    (await this.entry(provider)).setPassword(value);
  }

  async delete(provider: AiProvider): Promise<boolean> {
    const entry = await this.entry(provider);
    try {
      return entry.deletePassword();
    } catch {
      return false;
    }
  }

  private async entry(provider: AiProvider): Promise<KeyringEntry> {
    if (process.env['VITEST'] !== undefined) {
      throw new Error('KeychainSecretStore must not be used in tests; inject MemorySecretStore');
    }
    // Loaded lazily: the native module is only needed when keys are actually used.
    const { Entry } = await import('@napi-rs/keyring');
    return new Entry(this.service, provider);
  }
}
