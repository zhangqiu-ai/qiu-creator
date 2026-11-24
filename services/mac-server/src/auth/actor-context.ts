import { AsyncLocalStorage } from 'node:async_hooks';
import type { Principal } from './token-service.js';

/**
 * The principal behind the request being handled (QC-089), so services can
 * attribute changes (`change_log.actor`, agent revisions) and apply a
 * token's project limit without every call passing it along. Outside a
 * request (jobs, timers, file watchers) there is none.
 */
interface ActorStore {
  principal: Principal | null;
}

const store = new AsyncLocalStorage<ActorStore>();

/** Run `fn` (the rest of a request) with a fresh, empty actor slot. */
export function runWithActorSlot(fn: () => void): void {
  store.run({ principal: null }, fn);
}

/** Record who is making the current request (called by the auth hook). */
export function setCurrentPrincipal(principal: Principal): void {
  const slot = store.getStore();
  if (slot !== undefined) slot.principal = principal;
}

export function currentPrincipal(): Principal | null {
  return store.getStore()?.principal ?? null;
}

/** `owner`, an agent token id, or null outside a request. */
export function currentActorId(): string | null {
  return currentPrincipal()?.id ?? null;
}

/** Run `fn` as `principal` (tests, and work done for a request outside its hooks). */
export function runAs<T>(principal: Principal | null, fn: () => T): T {
  return store.run({ principal }, fn);
}
