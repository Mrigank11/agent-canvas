import { openExternalUrl, useRpc, type PluginHostProps } from "@getpaseo/plugin/client";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import { getRpc, listRpc, type CanvasView } from "../shared/contract";

// Own client so the plugin never depends on the host mounting a QueryClientProvider.
const queryClient = new QueryClient();
export function CanvasProvider({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

export type Theme = PluginHostProps["theme"];
const REFRESH_MS = 2000;

export function useViews(): { views: CanvasView[]; loading: boolean; unavailable: boolean } {
  const call = useRpc(listRpc);
  const q = useQuery({ queryKey: ["agent-canvas", "list"], queryFn: () => call({}), refetchInterval: REFRESH_MS, retry: false });
  return { views: q.data?.views ?? [], loading: q.isPending, unavailable: q.isError && !q.data };
}

export function useView(agentId: string): { view: CanvasView | null; state: { override: "on" | "off" | null; tools: boolean; show: boolean } | null; loading: boolean } {
  const call = useRpc(getRpc);
  const q = useQuery({ queryKey: ["agent-canvas", "get", agentId], queryFn: () => call({ agentId }), refetchInterval: REFRESH_MS, retry: false });
  return { view: q.data?.view ?? null, state: q.data?.state ?? null, loading: q.isPending };
}

/** A clock so ages in the strip keep moving between server pushes. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export function openUrl(url: string) {
  openExternalUrl(url).catch(() => {});
}
