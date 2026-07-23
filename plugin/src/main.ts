import { declareIndexPlugin } from "@remnote/plugin-sdk";
import type { ReactRNPlugin } from "@remnote/plugin-sdk";
import { activatePlugin, deactivatePlugin } from "./lifecycle.js";
import { renderPairWidget } from "./pairWidget.js";
import { selectWidgetRoute } from "./widgetRoute.js";

if (selectWidgetRoute(window.location.search) === "pair") {
  renderPairWidget();
} else {
  declareIndexPlugin(
    async (plugin: ReactRNPlugin) => {
      await activatePlugin(plugin);
    },
    async () => {
      deactivatePlugin();
    },
  );
}
