// UI for the RefBook Prompt / RefBook Image nodes: a picker button instead of the raw "ref" text,
// a "Use panel selection" button, and (for images) a preview. The node itself resolves the ref at run time.
import * as API from "./api.js";

const KINDS = { RefBookPrompt: "g", RefBookImage: "r" }; // what a node links to: prompt group or reference image
const ISOLATED = ["keydown", "keyup", "wheel", "pointerdown", "mousedown", "contextmenu", "paste", "copy"];
let getPanel = () => null;
let lastPointer = { x: 200, y: 200 };
window.addEventListener("pointerdown", (e) => { lastPointer = { x: e.clientX, y: e.clientY }; }, true);

const widget = (node, name) => node.widgets?.find((w) => w.name === name);

function parseLink(node) {
  try { return JSON.parse(widget(node, "ref")?.value || "null"); } catch { return null; }
}

export function setupRefBookNode(nodeType, nodeData, panelGetter) {
  const kind = KINDS[nodeData.name];
  if (!kind) return;
  getPanel = panelGetter;
  const onCreated = nodeType.prototype.onNodeCreated;
  nodeType.prototype.onNodeCreated = function () {
    const r = onCreated?.apply(this, arguments);
    initNode(this, kind);
    return r;
  };
  const onConfigure = nodeType.prototype.onConfigure;
  nodeType.prototype.onConfigure = function () {
    const r = onConfigure?.apply(this, arguments);
    refresh(this); // widget values are restored from the workflow after creation
    return r;
  };
  const onExecuted = nodeType.prototype.onExecuted;
  nodeType.prototype.onExecuted = function (output) {
    onExecuted?.apply(this, arguments);
    const text = output?.refbook_text?.[0];
    const snap = widget(this, "snapshot");
    if (text != null && snap) snap.value = text; // keep the workflow's fallback copy current
  };
}

function initNode(node, kind) {
  node.__rbKind = kind;
  const ref = widget(node, "ref");
  if (ref) {
    ref.hidden = true; // stored data, not something to edit by hand
    ref.computeSize = () => [0, -4];
  }
  // RefBook Prompt: the stored fallback text doubles as a read-only preview of the current prompt
  const snap = widget(node, "snapshot");
  if (snap?.element) {
    snap.element.readOnly = true;
    snap.element.placeholder = "The prompt appears here after you pick a group. Edit it in the RefBook panel.";
    snap.element.classList.add("rb-node-preview");
  }
  node.__rbPick = node.addWidget("button", "pick", null, () => openPicker(node));
  node.__rbPick.serialize = false;
  const useSel = node.addWidget("button", "Use panel selection", null, () => {
    const link = getPanel()?.selectionLink(kind);
    if (link) setNodeLink(node, link);
    else alertNode(node, kind === "g" ? "Select a prompt group in the RefBook panel first." : "Select an item with reference images in the RefBook panel first.");
  });
  useSel.serialize = false;
  if (kind === "r") {
    // own preview element instead of node.imgs: ComfyUI captions node.imgs with the *preview's* pixel size,
    // which would contradict the original size the node actually outputs
    const img = h("img", { class: "rb-node-img", draggable: "false" });
    const caption = h("div", { class: "rb-node-img-caption" });
    const box = h("div", { class: "rb-node-preview-box" }, img, caption);
    node.__rbPreview = { box, img, caption, height: 0 };
    const preview = node.addDOMWidget("preview", "rb-preview", box, {
      serialize: false,
      hideOnZoom: false,
      getMinHeight: () => node.__rbPreview.height,
      getMaxHeight: () => (node.__rbPreview.height ? 4000 : 0),
    });
    if (preview) preview.serialize = false; // display only, nothing to store in the workflow
  }
  refresh(node);
}

function alertNode(node, message) {
  const toast = window.comfyAPI?.app?.app?.extensionManager?.toast;
  if (toast) toast.add({ severity: "warn", summary: "RefBook", detail: message, life: 4000 });
  else window.alert(message);
}

// store a link on the node (also used by the panel when a reference is dropped on a RefBook Image node)
export async function setNodeLink(node, link) {
  const w = widget(node, "ref");
  if (!w || !link) return;
  w.value = JSON.stringify(link);
  await refresh(node);
}

// add a RefBook Image node linked to a reference, in the middle of the visible canvas
export function addLinkedImageNode(app, link) {
  const canvas = app.canvas;
  const graph = canvas.graph || app.graph;
  const rect = canvas.canvas.getBoundingClientRect();
  const { scale, offset } = canvas.ds;
  const node = window.LiteGraph.createNode("RefBookImage");
  node.pos = [rect.width / 2 / scale - offset[0] - 130, rect.height / 2 / scale - offset[1] - 150];
  graph.add(node);
  canvas.selectNode?.(node);
  setNodeLink(node, link);
  return node;
}

// re-read labels / previews / prompt text of every RefBook node on the canvas (after edits in the panel)
export function refreshRefBookNodes(graph) {
  projectCache.clear();
  for (const node of graph?._nodes || graph?.nodes || []) if (node.__rbKind) refresh(node);
}

// several nodes refreshing at once share one request per project
const projectCache = new Map();
function getProject(id) {
  if (!projectCache.has(id)) {
    projectCache.set(id, API.getProject(id));
    setTimeout(() => projectCache.delete(id), 2000);
  }
  return projectCache.get(id);
}

async function lookup(link) {
  const p = await getProject(link.p);
  const entry = p.sections.flatMap((s) => s.entries).find((e) => e.id === link.e);
  return link.g ? entry?.groups.find((x) => x.id === link.g) : (entry?.refs || []).find((x) => x.id === link.r);
}

async function refresh(node) {
  const btn = node.__rbPick;
  if (!btn) return;
  const link = parseLink(node);
  let item = null;
  if (link) {
    try { item = await lookup(link); } catch {}
  }
  let label = link?.path ? `🔗 ${link.path[2]} › ${item?.name || link.path[3] || "(unnamed)"}` : "Pick from RefBook…";
  if (node.__rbKind === "g") {
    const snap = widget(node, "snapshot");
    if (item && snap && snap.value !== item.text) snap.value = item.text; // also the fallback if RefBook is unreachable later
  } else {
    await showPreview(node, item);
  }
  if (link && !item) label = `⚠ ${label.slice(2)} (not found)`;
  btn.label = label;
  btn.name = label; // older frontends draw the name
  fitSize(node);
}

// node height = its widgets (the preview widget reports its own height)
function fitSize(node) {
  const [w, h] = node.computeSize();
  node.setSize?.([Math.max(260, w, node.size[0]), h]);
  node.graph?.setDirtyCanvas?.(true, true);
}

// medium-size preview (1024 px): sharp on the canvas without loading a multi-MB original.
// The caption shows the original's size, which is what the node outputs.
async function showPreview(node, r) {
  const pv = node.__rbPreview;
  if (!pv) return;
  if (!r) {
    pv.height = 0;
    pv.box.style.display = "none";
    return;
  }
  const loaded = new Promise((resolve) => { pv.img.onload = resolve; pv.img.onerror = resolve; });
  pv.img.src = API.imageUrl(r.image, "medium");
  let size = null;
  try { size = await (await fetch(API.imageUrl(r.image, "info"))).json(); } catch {}
  await loaded;
  const ratio = pv.img.naturalWidth ? pv.img.naturalHeight / pv.img.naturalWidth : 1;
  pv.height = Math.round(Math.min(420, Math.max(120, (Math.max(260, node.size[0]) - 20) * ratio))) + 18;
  pv.caption.textContent = size ? `Original ${size.width} × ${size.height}` : "";
  pv.box.style.display = "";
}

// ---------- picker: projects › sections › items › groups / reference images ----------

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c);
  return el;
}

async function openPicker(node) {
  document.querySelector(".rb-picker")?.remove();
  const kind = node.__rbKind;
  const list = h("div", { class: "rb-picker-list" }, h("div", { class: "rb-picker-empty", text: "Loading…" }));
  const search = h("input", { class: "rb-picker-search", placeholder: "Filter…", spellcheck: "false" });
  const box = h("div", { class: "rb-picker" },
    h("div", { class: "rb-picker-head" },
      h("span", { text: kind === "g" ? "Pick a prompt group" : "Pick a reference image" }),
      h("button", { class: "rb-icon-btn", text: "✕", title: "Close", onclick: () => close() })),
    search, list);
  for (const t of ISOLATED) box.addEventListener(t, (e) => e.stopPropagation());
  const close = () => {
    box.remove();
    document.removeEventListener("pointerdown", outside, true);
  };
  const outside = (e) => { if (!box.contains(e.target)) close(); };
  box.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
  document.body.append(box);
  const x = Math.min(lastPointer.x, window.innerWidth - box.offsetWidth - 8);
  const y = Math.min(lastPointer.y, window.innerHeight - box.offsetHeight - 8);
  Object.assign(box.style, { left: Math.max(8, x) + "px", top: Math.max(8, y) + "px" });
  setTimeout(() => document.addEventListener("pointerdown", outside, true));
  search.focus();

  let projects = [];
  try {
    const metas = (await API.listProjects()).filter((m) => !m.error);
    projects = await Promise.all(metas.map((m) => API.getProject(m.id)));
  } catch (err) {
    list.replaceChildren(h("div", { class: "rb-picker-empty", text: "Could not load RefBook: " + err.message }));
    return;
  }
  const current = parseLink(node);
  const render = () => {
    const q = search.value.trim().toLowerCase();
    const rows = [];
    for (const p of projects) {
      const projectRows = [];
      for (const s of p.sections) {
        for (const e of s.entries) {
          const items = kind === "g" ? e.groups : e.refs || [];
          const hit = (x) => !q || [p.name, s.name, e.name, x.name].some((t) => t.toLowerCase().includes(q));
          const shown = items.filter(hit);
          if (!shown.length) continue;
          const choose = (x) => {
            setNodeLink(node, { p: p.id, e: e.id, [kind]: x.id, path: [p.name, s.name, e.name, x.name] });
            close();
          };
          projectRows.push(h("div", { class: "rb-picker-entry" },
            h("div", { class: "rb-picker-entry-name" },
              e.cover ? h("img", { src: API.imageUrl(e.cover, "thumb"), loading: "lazy" }) : h("span", { class: "rb-picker-noimg" }),
              h("span", { text: e.name }), h("span", { class: "rb-picker-section", text: s.name })),
            h("div", { class: kind === "g" ? "rb-picker-chips" : "rb-picker-thumbs" },
              shown.map((x) => {
                const active = current && current[kind] === x.id;
                return kind === "g"
                  ? h("button", { class: "rb-picker-chip" + (active ? " rb-active" : ""), text: x.name, title: x.text.slice(0, 300), onclick: () => choose(x) })
                  : h("button", { class: "rb-picker-thumb" + (active ? " rb-active" : ""), title: x.name, onclick: () => choose(x) },
                      h("img", { src: API.imageUrl(x.image, "thumb"), loading: "lazy" }), h("span", { text: x.name }));
              }))));
        }
      }
      if (projectRows.length) rows.push(h("div", { class: "rb-picker-project", text: p.name }), ...projectRows);
    }
    list.replaceChildren(...(rows.length ? rows : [h("div", { class: "rb-picker-empty",
      text: kind === "g" ? "No prompt groups found." : "No reference images yet. Add some in the RefBook panel (🖼 Refs)." })]));
  };
  search.addEventListener("input", render);
  render();
}
