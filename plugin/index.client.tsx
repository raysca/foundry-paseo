import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { ChatScreen } from "./client/chat";
import { FeatureScreen } from "./client/feature";
import { HomeScreen } from "./client/home";
import { SCREEN, setOpener } from "./client/kit";
import { IssueScreen } from "./client/review";
import { FoundrySettingsScreen } from "./client/settings";

function FoundrySidebarItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  const ours = !!currentScreen && (Object.values(SCREEN) as string[]).includes(currentScreen.screenId);
  return <SidebarRow icon="Factory" label="Foundry" active={ours} onPress={() => openScreen({ screenId: SCREEN.home })} />;
}

export default function contribute(client: PluginClientContext) {
  setOpener((input) => client.openScreen(input));
  const cleanups = [
    client.addSettingsScreen({ id: "foundry", title: "Foundry", icon: "Settings", Component: FoundrySettingsScreen }),
    client.addScreen({ id: SCREEN.home, title: "Foundry", Component: HomeScreen }),
    client.addScreen({ id: SCREEN.feature, title: "Feature", Component: FeatureScreen }),
    client.addScreen({ id: SCREEN.issue, title: (p) => p.key ?? "Task", Component: IssueScreen }),
    client.addScreen({ id: SCREEN.chat, title: "Project manager", Component: ChatScreen }),
    client.addSidebarHeaderItem({ id: "foundry", title: "Foundry", Component: FoundrySidebarItem }),
  ];
  return () => cleanups.forEach((c) => c());
}
