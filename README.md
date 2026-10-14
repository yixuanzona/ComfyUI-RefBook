# ComfyUI-RefBook

**A floating reference book for your ComfyUI projects.** Every character, prop, background, style, reference image and prompt of a project lives in one panel that floats freely over the canvas. Move it anywhere, resize it, or collapse it to a small bar when you need the space, then open it again with one click or **Alt+P**.

RefBook is a panel, not a node, so it stays on screen whichever workflow you open, and typing or scrolling in it never affects the canvas.

![The RefBook panel floating over a workflow](docs/images/panel.png)

## Use cases

- **A reference book for every project.** Build a dedicated book for each IP or client: characters, props, backgrounds, styles, reference images and prompts, all in one place that is easy to read and quick to search through, instead of scattered across old workflows and folders.
- **Team work.** Put the book in a shared NAS folder and the whole team works from the same references. Changes show up on every computer within seconds, so nobody generates with an outdated prompt or picture. See [Share between computers](#share-between-computers-nas).
- **LoRA training.** Keep caption and trigger prompts consistent for every character.
- **Asset production.** Generate sprites, illustrations or variations with the same base prompt every time.
- **Story scenes.** Combine a character, a background and a style for each scene without hunting through old workflows.

## Install

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/yixuanzona/ComfyUI-RefBook.git
```

Restart ComfyUI. No extra Python packages are needed.

## How to use

1. Click the **RB** bar at the top right (or press **Alt+P**) to open the panel. Click the bar again to collapse it. Drag the bar to move it.
2. Pick a **section**, for example Character, Background or Style.
3. Pick an **item** from the row of pictures, for example a character.
4. Pick a **prompt group**, for example Features or Action, and its prompt shows in the big box.
5. Click **Copy** and paste the prompt into your workflow.

Sections, items and prompt groups are all yours to define: add, rename, reorder or delete them to fit your project. Each row ends with **＋** to add something new; hover over any name to see **✎** (rename) and **✕** (delete). The groups a new item starts with (Features, Action by default) can be changed in **ComfyUI Settings → RefBook**.

## Features

| | |
|---|---|
| **Projects** | One project per IP. Duplicate a project to keep separate stages, such as "Project" and "Project · Final". |
| **Pictures** | Drag an image onto a card, paste it with **Ctrl+V**, or click 🖼. Click the selected card to view it full size. |
| **Edit in place** | Type straight into the prompt box. Everything saves automatically. |
| **Large editor** | **⤢** opens a big window for long prompts. |
| **Undo** | **Undo** steps back through your prompt edits. Deleted items can be restored with the **Undo** link at the bottom for 8 seconds. |
| **Drag to reorder** | Sections, cards and groups. Drop a card on another section to move it. |
| **Safe storage** | Plain files, a backup before every save (last 20 kept), and a trash folder for deleted items. |

## Reference images (Refs)

Every item has its own 🖼 **Refs** gallery at the end of its group row. Drop in any reference for that item, such as character sheets, turnarounds, expressions, palettes or mood images, and the right one is always a click away while you work. Originals are kept at full quality.

![The Refs gallery of a character](docs/images/refs.png)

- **Drag an image onto the canvas** to load a copy into a Load Image node, or drop it on an existing Load Image to swap the picture.
- **🔗** (or **Alt**+drag) adds a linked **RefBook Image** node instead, which follows later updates. See [Nodes](#nodes-stay-in-sync-with-refbook).
- **↻** replaces an image with a new version, keeping its place and name.
- **★** makes it the item's cover.

![Dragging a reference onto the canvas](docs/images/drag-to-canvas.gif)

## Nodes: stay in sync with RefBook

There are two ways to bring a prompt or picture into a workflow. Use whichever fits:

| | Copy / drag to canvas | RefBook nodes |
|---|---|---|
| When RefBook changes | Stays as it was | Uses the new version on the next run |
| Good for | Locking a final version | Team work, references that are still changing |

The nodes are in the **RefBook** category:

- **RefBook Image** works like a Load Image node, except the picture comes from RefBook. When someone replaces the image in the gallery (↻), the node picks up the new one, so the workflow never falls out of sync. Outputs IMAGE + MASK at original size.
- **RefBook Prompt** outputs the text of a prompt group, for example into CLIP Text Encode, and shows the current text on the node.

![RefBook Prompt and RefBook Image nodes in a workflow](docs/images/nodes.png)

To choose what a node shows, click **Pick from RefBook…** or **Use panel selection** on the node, or use 🔗 / Alt+drag in the Refs gallery. Dropping a reference onto an existing RefBook Image node relinks it.

If RefBook can't be reached (for example the NAS is offline), the node keeps using the last version it loaded and shows a warning in the console, so the workflow doesn't stop.

## Where your data is

```
ComfyUI/user/default/ref_book/
  projects/   one JSON file per project
  images/     cover pictures
  originals/  reference images (full quality)
  thumbs/     small previews (rebuilt automatically)
  .backups/   automatic backups
  .trash/     deleted items
```

## Share between computers (NAS)

1. Create a shared folder on your NAS, for example `\\NAS\share\RefBook`.
2. On each computer, open the panel's **⋯** menu → **Data folder…** and enter that path. A mapped drive such as `Z:\RefBook` also works.
3. The first time, RefBook offers to copy your existing projects into the new folder.

Changes made on another computer show up automatically within about 15 seconds. If two people edit the same project at the same time, a bar appears with **Reload** (take theirs) or **Keep mine**.

Tips: keep the NAS off the public internet, limit the share to your team, and turn on NAS snapshots.

## Planned

- Search across items and prompts
- Export / import a project as a single file

## License

MIT
