# RefBook development notes

For whoever (person or AI assistant) continues work on this repo. User-facing docs are in the [README](../README.md).

## What it is

A ComfyUI custom node package with two halves:

1. **Floating panel** (frontend extension): an always-on-screen panel to manage an IP's reusable prompts and reference images: project → section → item → prompt groups + reference gallery ("Refs").
2. **Nodes** (V3 API): `RefBook Prompt` (STRING) and `RefBook Image` (IMAGE + MASK) read the RefBook folder on every run, so workflows follow edits.

Data is plain files in a folder (default `ComfyUI/user/default/ref_book/`, or a shared NAS folder chosen in the panel).

## Layout

```
__init__.py        imports server.routes (registers the API) and exports WEB_DIRECTORY + comfy_entrypoint
nodes.py           RefBook Prompt / RefBook Image (V3 io.ComfyNode)
server/store.py    Vault: project JSON, images, backups, trash, ref resolution. Pure file IO, no ComfyUI imports
server/routes.py   aiohttp routes under /refbook/api on PromptServer.instance.routes; data-folder config
web/refBook.js     extension entry: mounts the panel, Alt+P command, settings, hooks node UI
web/panel.js       the floating panel (plain DOM, no framework)
web/nodeUi.js      node widgets: picker, "Use panel selection", previews, setNodeLink / addLinkedImageNode
web/api.js         fetch wrapper (uses ComfyUI's api.fetchApi)
web/style.css      all classes prefixed rb-, colours from ComfyUI theme variables
docs/              README images, this file
```

Every `.js` in `web/` is loaded by ComfyUI as an extension module. Only `refBook.js` has side effects; the others just export.

## Data model (one JSON file per project: `projects/<slug>__<projectId>.json`)

```
project { schema, id "p_xxxxxx", name, rev, updatedAt, sections[] }
section { id "s_…", name, entries[] }
entry   { id "e_…", name, cover (image id | null), groups[], refs[] }
group   { id "g_…", name, text, inAll }
ref     { id (slot), image "i_…", name }   // Replace changes image, keeps the slot id
```

- Ids match `^[a-z]_[a-z0-9]{4,12}$` and are validated before being used in any path.
- Keys are written in a fixed order (readable diffs). **Unknown keys are kept** (`_with_extras`), so an older RefBook on another computer never wipes newer fields. Keep it that way when adding fields.
- Older refs had no `image`; their `id` was the image id. `normalize_project` fills `image` from `id`.
- Images: covers `images/<id>.webp` (re-encoded, 1280 px); references `originals/<id>.png|jpg|webp` (original pixels; PNG/WEBP re-saved losslessly without embedded workflow metadata, JPEG byte-for-byte); `thumbs/<id>.webp` (256 px) and `thumbs/<id>_m.webp` (1024 px) are generated on demand.
- Saving: atomic write (temp file + rename), `rev` + 1, backup of the previous file to `.backups/<projectId>/` (last 20). `PUT` with an older `baseRev` returns 409 (another computer saved first).
- Deleting: removed sections/entries/groups are snapshotted to `.trash/items/`; images no longer referenced by any project move to `.trash/` and come back if an undo re-references them.

## API (`/api/refbook/api/...`)

| Method | Path | |
|---|---|---|
| GET | /projects | list (id, name, rev, updatedAt, error?) |
| POST | /projects | `{name, copyFrom?}` |
| GET / PUT / DELETE | /projects/{id} | PUT body `{project, baseRev}`; 409 on conflict |
| POST | /trash/restore | `{kind: "project", id}` |
| POST | /images | multipart `kind` (`cover` / `ref`) + `image`; returns `{imageId}` |
| GET | /images/{id}?size=thumb\|medium\|full\|info | `info` returns `{width, height}` |
| GET / PUT | /config | data folder; PUT `{vaultDir, dryRun?, copyExisting?}`; `REFBOOK_DIR` env var overrides |

## Nodes

- Registered with `comfy_entrypoint` (V3). `__init__.py` must **not** define `NODE_CLASS_MAPPINGS`, or ComfyUI takes the V1 path and ignores the entrypoint.
- Inputs `ref` (JSON: `{p, e, g|r, path:[project, section, item, name]}`) and, on the prompt node, `snapshot` are `socketless` strings. The frontend hides `ref` and shows `snapshot` read-only as the prompt preview.
- Resolution (`Vault.resolve`): ids first, then names from `path`. If nothing resolves: prompt uses `snapshot`, image uses the per-computer cache `user/default/ref_book_cache/<slot>.*`; both log a warning. Without a fallback the node raises a clear error.
- `fingerprint_inputs` hashes the resolved text / image file, so edits re-run the node and unchanged content uses the cache.
- **Windows console gotcha:** error and warning text goes through `_console_safe()`. Characters the console can't encode (cp950 on a Traditional Chinese Windows) made ComfyUI's own error reporting crash ("lost sys.stderr").

## Frontend notes

- Panel events are isolated (`stopPropagation` on key/wheel/pointer/paste/drop…) so typing or scrolling never reaches the canvas or ComfyUI shortcuts.
- Dragging a reference onto the canvas: a capture-phase `drop` listener on `window` calls `preventDefault()`; ComfyUI's own drop handler skips handled events. Plain drop = copy into ComfyUI's input folder + Load Image. Alt or the 🔗 button = linked RefBook Image node. `effectAllowed` must stay `"all"`, or the Alt "link" drop gets cancelled.
- Node hit-testing uses `pos`/`size` directly, not LiteGraph's render-time bounding box.
- Image node preview is a DOM widget (not `node.imgs`): ComfyUI captions `node.imgs` with the preview's pixel size, which looks like the output size.
- Changes from other computers: poll `/projects` every 15 s and on window focus. A newer `rev` reloads silently unless the user is typing; unsaved local edits show the Reload / Keep mine banner.
- UI text is English. Keep the UI minimal: single column, edit in place with autosave, hover ✎ / ✕ with undo, no edit modes.

## Testing without touching a live ComfyUI

Use a separate ComfyUI process with its own base folder (custom_nodes with a junction to the working copy), user folder and an in-memory database:

```
python_embeded\python.exe -s ComfyUI\main.py --port 8199 --cpu ^
  --base-directory <scratch>\testbase --user-directory <scratch>\testbase\user ^
  --database-url sqlite:///:memory: --disable-auto-launch
```

- Two such instances (8199 / 8198, different user folders, same data folder) simulate two computers sharing a NAS.
- Nodes can be run through `POST /api/prompt` with a `PreviewAny` / `PreviewImage` output and checked via `/api/history/<id>`.
- Python changes need a ComfyUI restart; `web/` changes only need a page reload.
- In a hidden browser pane `document.hidden` is true, and the panel skips polling then (by design).

## Release flow used so far

1. Work on a branch (a git worktree keeps the live install untouched).
2. Test in the isolated instances.
3. Push the branch; the user and a colleague test it on the real NAS.
4. Fast-forward `main` and push.

## Status (2026-10)

Done and on `main`: panel, NAS data folder with conflict handling, Refs gallery, RefBook Prompt / Image nodes.

Next:
- **Publish to ComfyUI Manager** via the Comfy Registry: add `pyproject.toml` (`[project]` name `comfyui-refbook`, version, description, license MIT, `[project.urls]` Repository; `[tool.comfy]` PublisherId, DisplayName). Waiting for the owner's Publisher ID. Optional: a GitHub Action that publishes on version tags.
- README polish and example images (screenshots / a GIF of dragging a reference onto the canvas), done by the owner. Use a demo project, not unreleased IP.
- Planned features: search across items and prompts; export / import a project as one file.
- Old test branches (`phase2-nas`, `refs-gallery`, `refbook-nodes`) are fully merged and can be deleted once nobody is on them.
