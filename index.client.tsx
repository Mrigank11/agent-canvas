import type { PluginClientContext } from "@getpaseo/plugin/client";
import { SidePanelBody, LIST_SCREEN, ListItem, ListScreen } from "./client/screens";
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
      context: "workspace",
      locations: ["explorer", "workspace"],
      Component: ({ workspaceId, theme, layout, navigation }) => (
        <CanvasProvider>
          <SidePanelBody workspaceId={workspaceId} theme={theme} layout={layout} navigation={navigation} />
        </CanvasProvider>
      ),
    }),
    // The canvas tool calls are bookkeeping: the card shows their result, so the call rows are noise.
    // Every other tool call stays: hiding those would hide what the agent actually did.
    client.addTimelineTransformer({
      id: "hide-canvas-calls",
      query: { itemType: "tool_call" },
      transform: ({ item }) => (/canvas_(set|patch|get)/.test(item.name) ? { items: [] } : undefined),
    }),
    client.addTimelineRenderer({ kind: ROW_KIND, version: ROW_VERSION, schema: rowData, Component: CanvasRow }),
    contributePills(client),
  ];
  return () => { for (const c of cleanups) c(); };
}
