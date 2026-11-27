import type { PluginClientContext } from "@getpaseo/plugin/client";
import { FoundrySettingsScreen } from "./client/settings";

export default function contribute(client: PluginClientContext) {
  client.addSettingsScreen({ id: "foundry", title: "Foundry", icon: "Settings", Component: FoundrySettingsScreen });
  return () => {};
}
