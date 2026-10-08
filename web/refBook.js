// Extension entry: mounts the floating panel and registers the toggle command / Alt+P keybinding.
import { app } from "../../scripts/app.js";
import { Panel, HOTKEY } from "./panel.js";
import { setupRefBookNode } from "./nodeUi.js";

let panel = null;

app.registerExtension({
  name: "RefBook.Panel",

  settings: [
    {
      id: "RefBook.DefaultGroups",
      name: "Default groups for a new item (comma-separated)",
      type: "text",
      defaultValue: "Features, Action",
    },
  ],

  commands: [
    {
      id: "RefBook.TogglePanel",
      label: "RefBook: Toggle panel",
      icon: "pi pi-book",
      function: () => panel?.toggle(),
    },
  ],

  keybindings: [
    { commandId: "RefBook.TogglePanel", combo: { key: HOTKEY.key, alt: HOTKEY.alt } },
    { commandId: "RefBook.TogglePanel", combo: { key: HOTKEY.macKey, alt: HOTKEY.alt } }, // macOS Option+P types "π"
  ],

  // RefBook Prompt / RefBook Image nodes get a picker instead of their raw stored data
  async beforeRegisterNodeDef(nodeType, nodeData) {
    setupRefBookNode(nodeType, nodeData, () => panel);
  },

  async setup() {
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = new URL("./style.css", import.meta.url).href;
    document.head.append(css);

    panel = new Panel(app);
    panel.mount();
  },
});
