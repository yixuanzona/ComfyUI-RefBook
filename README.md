# ComfyUI-RefBook

A small floating panel in ComfyUI that keeps your project's characters, backgrounds and styles in one place. Each one has a picture and its prompts, ready to copy.

![RefBook panel](docs/screenshot.jpg)

## Use cases

- **Long-running IP projects.** Keep each character's look, signature poses, recurring backgrounds and art style in one place, and reuse them across every workflow.
- **LoRA training.** Keep caption and trigger prompts consistent for every character.
- **Asset production.** Generate sprites, illustrations or variations with the same base prompt every time.
- **Story scenes.** Combine a character, a background and a style for each scene without hunting through old workflows.

Prompt nodes live inside a single workflow and are gone when you switch workflows. RefBook stays on screen whichever workflow is open.

## Install

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/yixuanzona/ComfyUI-RefBook.git
```

Restart ComfyUI. No extra Python packages are needed.

## How to use

1. Click the **RB** bar at the top right (or press **Alt+P**) to open the panel. Click the bar again to collapse it. Drag the bar to move it.
2. Pick a **section** (Character / Background / Style).
3. Pick an **item** from the row of pictures, for example a character.
4. Pick a **prompt group** (Features / Action) and its prompt shows in the big box.
5. Click **Copy** and paste the prompt into your workflow.

Each row ends with **＋** to add something new. Hover over any name to see **✎** (rename) and **✕** (delete).

## Features

- **Always on screen.** A floating panel, not a node, so it never gets lost in a workflow. Typing or scrolling in the panel never affects the canvas.
- **Projects.** One project per IP. Duplicate a project to keep separate stages, such as "Project" and "Project · Final".
- **Pictures.** Drag an image onto a card, paste it with **Ctrl+V**, or click 🖼. Click the selected card to view it full size.
- **Edit in place.** Type straight into the prompt box. Everything saves automatically.
- **Undo.** **Undo** steps back through your prompt edits. Deleted items can be restored with the **Undo** link at the bottom for 8 seconds.
- **Large editor.** **⤢** opens a big window for long prompts.
- **Reference images (Refs).** Each item has a 🖼 **Refs** tab with a gallery for character sheets, turnarounds, palettes or mood images. Originals are kept at full quality. **Drag an image onto the canvas** to load it into a Load Image node, or drop it on an existing Load Image to swap the picture. ★ makes an image the item's cover.
- **Drag to reorder** sections, cards and groups. Drop a card on another section to move it.
- **Safe storage.** Plain files, a backup before every save (last 20 kept), and a trash folder for deleted items.

The default group names for new items can be changed in **ComfyUI Settings → RefBook**.

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
- A RefBook node that sends the selected prompt straight into your workflow

## License

MIT
