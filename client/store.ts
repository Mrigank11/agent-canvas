// Two tiny shared stores. The pill (one per agent) and the side panel (one per workspace) live in different
// React trees, so they talk through module state instead of props.
import { useSyncExternalStore } from "react";
import type { PillState } from "../shared/pill";

function makeStore<T>(initial: T) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next: T) { value = next; listeners.forEach((l) => l()); },
    subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l); }; },
  };
}

/** workspaceId -> the agent whose composer is on screen. The pill's icon reports it when it mounts. */
export const focusStore = makeStore<Record<string, string>>({});
/** agentId -> what its pill shows. Written by the poller in the client entry. */
export const pillStore = makeStore<Record<string, PillState>>({});

export function reportFocus(workspaceId: string, agentId: string) {
  if (focusStore.get()[workspaceId] !== agentId) focusStore.set({ ...focusStore.get(), [workspaceId]: agentId });
}
export function useFocusedAgent(workspaceId: string): string | null {
  return useSyncExternalStore(focusStore.subscribe, () => focusStore.get()[workspaceId] ?? null);
}
export function usePillState(agentId: string): PillState | null {
  return useSyncExternalStore(pillStore.subscribe, () => pillStore.get()[agentId] ?? null);
}
