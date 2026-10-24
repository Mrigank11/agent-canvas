import type { PluginClientContext } from "@getpaseo/plugin/client";
import { AgentPanelBody, LIST_SCREEN, ListItem, ListScreen } from "./client/screens";
import { CanvasProvider } from "./client/common";
import { contributePills } from "./client/pill";
import { CanvasRow } from "./client/timeline";
import { ROW_KIND, ROW_VERSION, rowData } from "./shared/contract";

export default function contribute(client: PluginClientContext) {
  const cleanups = [
    client.addScreen({ id: LIST_SCREEN, title: "Canvases", Component: ListScreen }),
    client.addSidebarHeaderItem({ id: "canvases", title: "Canvases", Component: ListItem }),
    client.addWorkspacePanel({
      id: "canvas",
      title: "Canvas",
      icon: "LayoutDashboard",
      context: "agent",
      Component: ({ agentId, theme, layout }) => (
        <CanvasProvider>
          <AgentPanelBody agentId={agentId} theme={theme} layout={layout} />
        </CanvasProvider>
      ),
    }),
    client.addTimelineRenderer({ kind: ROW_KIND, version: ROW_VERSION, schema: rowData, Component: CanvasRow }),
    contributePills(client),
  ];
  return () => { for (const c of cleanups) c(); };
}
