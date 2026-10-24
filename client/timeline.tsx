import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { View } from "react-native";
import type { z } from "zod";
import type { rowData } from "../shared/contract";
import { CanvasBody } from "./canvas";
import { CanvasProvider } from "./common";

/** The canvas row in the agent's pane: same tree, same strip, updated in place by the daemon. */
export function CanvasRow({ item, theme }: PluginTimelineItemProps<z.output<typeof rowData>>) {
  const data = item.data;
  if ("superseded" in data) return null; // the canvas moved to a newer row below
  return (
    <CanvasProvider>
      <View style={{ padding: 12, borderRadius: 14, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface0 }}>
        <CanvasBody view={data} theme={theme} withBrowserLink />
      </View>
    </CanvasProvider>
  );
}
