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
  for (const name of ["ref", "snapshot"]) {
    const w = widget(node, name);
    if (!w) continue;
    w.hidden = true; // stored data, not something to edit by hand
    w.computeSize = () => [0, -4];
    if (w.element) w.element.style.display = "none"; // multiline DOM widget
  }
  node.__rbPick = node.addWidget("button", "pick", null, () => openPicker(node));
  node.__rbPick.serialize = false;
  const useSel = node.addWidget("button", "Use panel selection", null, () => {
    const link = getPanel()?.selectionLink(kind);
    if (link) setNodeLink(node, link);
    else alertNode(node, kind === "g" ? "Select a prompt group in the RefBook panel first." : "Select an item with reference images in the RefBook panel first.");
  });
  useSel.serialize = false;
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
  if (link.g) {
    try { // fill the fallback text right away, so the workflow carries it even before the first run
      const p = await API.getProject(link.p);
      const g = p.sections.flatMap((s) => s.entries).find((e) => e.id === link.e)?.groups.find((x) => x.id === link.g);
      const snap = widget(node, "snapshot");
      if (g && snap) snap.value = g.text;
    } catch {}
  }
  refresh(node);
}

// re-read labels / previews of every RefBook node on the canvas (e.g. after a reference was replaced)
export function refreshRefBookNodes(graph) {
  for (const node of graph?._nodes || graph?.nodes || []) if (node.__rbKind) refresh(node);
}

async function refresh(node) {
  const btn = node.__rbPick;
  if (!btn) return;
  const link = parseLink(node);
  const label = link?.path ? `🔗 ${link.path[2]} › ${link.path[3] || "(unnamed)"}` : "Pick from RefBook…";
  btn.label = label;
  btn.name = label; // older frontends draw the name
  fitSize(node);
  if (node.__rbKind === "r") await showPreview(node, link);
}

const PREVIEW_H = 220;

// height = visible widgets (+ room for the preview image); the hidden stored-data widgets take no space
function fitSize(node) {
  const [w, h] = node.computeSize();
  node.setSize?.([Math.max(260, w, node.size[0]), h + (node.imgs?.length ? PREVIEW_H : 0)]);
  node.graph?.setDirtyCanvas?.(true, true);
}

async function showPreview(node, link) {
  node.imgs = undefined;
  if (!link?.r) return;
  try {
    const p = await API.getProject(link.p);
    const r = p.sections.flatMap((s) => s.entries).flatMap((e) => e.refs || []).find((x) => x.id === link.r);
    if (!r) return;
    const img = new Image();
    img.onload = () => {
      node.imgs = [img];
      fitSize(node);
    };
    img.src = API.imageUrl(r.image, "thumb");
  } catch {}
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
