import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useSettings } from "@getpaseo/plugin/client";
import { SettingsCard, SettingsRow, SettingsSection, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { Text } from "react-native";
import { canvasSettings, ENV_KEY, LABEL_KEY } from "../shared/config";

/** Settings > Plugins > Agent canvas: the host-wide defaults. A per-agent override always beats these. */
export function CanvasSettings({ theme }: PluginSurfaceProps) {
  const s = useSettings(canvasSettings);
  const muted = { color: theme.colors.foregroundMuted, fontSize: 13 } as const;
  if (s.status === "loading") return <Text style={muted}>Loading…</Text>;
  if (s.status === "error") return <Text style={muted}>Could not read the settings: {s.error}</Text>;
  if (s.status === "invalid") return <Text style={muted}>The stored settings are invalid ({s.error}). Reset to the defaults to continue.</Text>;
  const v = s.values;
  return (
    <>
      <SettingsSection title="Defaults for all agents">
        <SettingsCard>
          <SettingsSwitch
            label="Give every new agent the canvas tools"
            hint="Off: only agents started with the override get them."
            value={v.defaultOn}
            disabled={s.saving}
            onValueChange={(defaultOn) => void s.save({ ...v, defaultOn }, s.revision)}
          />
          <SettingsSwitch
            label="Show an auto canvas for agents that write none"
            hint="Built from the agent's timeline. Off: agents without the override have no canvas at all."
            value={v.autoCanvas}
            disabled={s.saving}
            onValueChange={(autoCanvas) => void s.save({ ...v, autoCanvas }, s.revision)}
          />
        </SettingsCard>
        {s.saveError ? <Text style={{ color: theme.colors.statusDanger, fontSize: 13 }}>{s.saveError}</Text> : null}
      </SettingsSection>
      <SettingsSection title="Per-agent override">
        <SettingsCard>
          <SettingsRow label={`Env ${ENV_KEY}=on | off`} hint="Set when the agent is created (CLI --env, SDK). Gives the agent real canvas tools, or keeps them out." />
          <SettingsRow label={`Label ${LABEL_KEY}=on | off`} hint="The only thing the MCP create_agent tool can set. The agent is told how to use the canvas over HTTP after it starts." />
          <SettingsRow label="Canvas pill" hint="Turn it on or off for one running agent. The latest explicit choice wins." />
        </SettingsCard>
      </SettingsSection>
    </>
  );
}
