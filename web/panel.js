// RefBook floating panel: plain DOM, no framework. All classes are prefixed with rb-.
// Layout (single column): bar (project) -> section tabs -> entry tiles -> group tabs -> big prompt box.
import * as API from "./api.js";

// ---- constants (change here) ----
export const HOTKEY = { key: "p", macKey: "π", code: "KeyP", alt: true }; // Alt+P
const LS_KEY = "refbook.ui.v1";
const DEFAULT_W = 420, DEFAULT_H = 540, MIN_W = 340, MIN_H = 320; // default ≈ a bit wider than ComfyUI's Run bar
const SAVE_DELAY = 500;
const POLL_MS = 15000; // check for edits made on other computers (shared NAS folder)
const UNDO_MS = 8000;
const COPIED_MS = 1200;
const HISTORY_IDLE_MS = 1000; // a pause this long starts a new Undo step
const HISTORY_MAX = 100;
const DND_TYPE = "application/x-refbook";
const DEFAULT_GROUPS_SETTING = "RefBook.DefaultGroups";
// events that must not reach ComfyUI (canvas zoom, node shortcuts, paste-as-node, file-drop-as-workflow)
const ISOLATED_EVENTS = ["keydown", "keyup", "keypress", "wheel", "pointerdown", "mousedown", "dblclick",
  "contextmenu", "paste", "copy", "cut", "dragenter", "dragover", "drop"];

const ICON_COPY = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>`;
const ICON_UNDO = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/></svg>`;
const ICON_EXPAND = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/></svg>`;
const ICON_CHECK =`<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L20 7"/></svg>`;

// ---- small helpers ----
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k === "html") el.innerHTML = v;
    else if (k === "style") el.style.cssText = v;
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k in el && typeof v !== "string") el[k] = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c);
  return el;
}

function newId(prefix) {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const buf = crypto.getRandomValues(new Uint8Array(6));
  return prefix + "_" + Array.from(buf, (b) => chars[b % chars.length]).join("");
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const charCount = (s) => [...s].length;
const hhmm = (d = new Date()) => d.toTimeString().slice(0, 5);

function isolate(el) {
  for (const t of ISOLATED_EVENTS) el.addEventListener(t, (e) => e.stopPropagation());
}

function imageFileFrom(dataTransferOrClipboard) {
  for (const it of dataTransferOrClipboard?.items || []) {
    if (it.kind === "file" && it.type.startsWith("image/")) return it.getAsFile();
  }
  for (const f of dataTransferOrClipboard?.files || []) if (f.type.startsWith("image/")) return f;
  return null;
}

function moveInArrays(src, srcIdx, dst, dstIdx) {
  const [item] = src.splice(srcIdx, 1);
  if (src === dst && srcIdx < dstIdx) dstIdx--;
  dst.splice(dstIdx, 0, item);
}

function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch { return {}; }
}

export class Panel {
  constructor(app) {
    this.app = app;
    this.prefs = Object.assign({
      mode: "bar", x: null, y: null, w: DEFAULT_W, h: DEFAULT_H,
      projectId: null, sel: {}, // sel[projectId] = { s, e, g } last selected section / entry / group
    }, loadPrefs());
    if (this.prefs.mode !== "open") this.prefs.mode = "bar";
    this.projects = [];
    this.project = null;
    this.projectError = null;
    this.sel = { s: null, e: null, g: null };
    this.history = new Map(); // groupId -> previous texts, for Undo
    this.burst = null; // { g, t } current typing burst
    this.dirty = false;
    this.saving = null;
    this.saveTimer = null;
    this.drag = null;
    this.undoTimer = null;
  }

  savePrefs() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(this.prefs)); } catch {}
  }

  // ================= mount & window behaviour =================

  mount() {
    this.select = h("select", { class: "rb-project-select", title: "Switch project", onchange: (e) => this.switchProject(e.target.value) });
    this.projectSlot = h("div", { class: "rb-project-slot" }, this.select);
    this.toggleBtn = h("button", { class: "rb-icon-btn", onclick: () => this.toggle() });
    this.bar = h("div", { class: "rb-bar" },
      h("span", { class: "rb-logo", text: "RB" }),
      this.projectSlot,
      h("div", { class: "rb-flex" }),
      this.menuBtn = h("button", { class: "rb-icon-btn rb-open-only", title: "Project menu", text: "⋯", onclick: (e) => this.projectMenu(e.currentTarget) }),
      this.toggleBtn,
    );
    this.secRow = h("div", { class: "rb-tabs rb-sec-tabs" });
    this.tileRow = h("div", { class: "rb-tiles" });
    this.groupRow = h("div", { class: "rb-tabs rb-group-tabs" });
    this.editor = h("div", { class: "rb-editor" });
    this.statusText = h("span", { class: "rb-status-text" });
    this.statusActions = h("span", { class: "rb-status-actions" });
    this.body = h("div", { class: "rb-body" }, this.secRow, this.tileRow, this.groupRow, this.editor);
    this.banner = h("div", { class: "rb-banner", hidden: true });
    this.root = h("div", { class: "rb-root", tabindex: "-1" },
      this.bar,
      this.banner,
      this.body,
      h("div", { class: "rb-status" }, this.statusText, this.statusActions),
      ...["nw", "ne", "sw", "se"].map((d) => h("div", { class: `rb-rz rb-rz-${d}`, dataset: { dir: d } })),
    );
    isolate(this.root);
    this.root.addEventListener("keydown", (e) => this.onKeydown(e));
    this.root.addEventListener("paste", (e) => this.onPaste(e));
    // keep the browser from opening files dropped anywhere on the panel
    this.root.addEventListener("dragover", (e) => e.preventDefault());
    this.root.addEventListener("drop", (e) => e.preventDefault());

    this.fileInput = h("input", { type: "file", accept: "image/*", style: "display:none", onchange: (e) => {
      const f = e.target.files[0];
      e.target.value = "";
      if (f) this.setCover(f, this.coverTarget);
    } });
    this.root.append(this.fileInput);

    document.body.append(this.root);
    this.setupBarDrag();
    this.setupResize();
    window.addEventListener("resize", () => this.applyLayout());
    window.addEventListener("pagehide", () => this.flush());
    document.addEventListener("visibilitychange", () => { if (document.hidden) this.flush(); });
    window.addEventListener("focus", () => this.checkRemote());
    setInterval(() => this.checkRemote(), POLL_MS);

    this.applyLayout();
    this.loadProjects(this.prefs.projectId);
  }

  setMode(mode) {
    this.prefs.mode = mode;
    this.savePrefs();
    this.applyLayout();
    if (mode === "open") this.root.focus({ preventScroll: true });
  }

  toggle() {
    this.setMode(this.prefs.mode === "open" ? "bar" : "open");
  }

  applyLayout() {
    // Saved prefs are never overwritten here, so a small window only shrinks/pulls the panel back temporarily.
    const p = this.prefs, open = p.mode === "open";
    const vw = window.innerWidth, vh = window.innerHeight;
    this.root.dataset.mode = p.mode;
    this.toggleBtn.textContent = open ? "▴" : "▾";
    this.toggleBtn.title = (open ? "Collapse" : "Expand") + " (Alt+P)";
    const w = open ? clamp(p.w || DEFAULT_W, Math.min(MIN_W, vw), vw) : null;
    const hh = open ? clamp(p.h || DEFAULT_H, Math.min(MIN_H, vh), vh) : null;
    Object.assign(this.root.style, { width: open ? w + "px" : "auto", height: open ? hh + "px" : "auto" });
    const rw = this.root.offsetWidth || w || 200, rh = this.root.offsetHeight || hh || 36;
    const x = clamp(p.x ?? vw - rw - 24, 0, Math.max(0, vw - rw));
    const y = clamp(p.y ?? 96, 0, Math.max(0, vh - rh));
    Object.assign(this.root.style, { left: x + "px", top: y + "px" });
  }

  // the panel's current on-screen rect (what applyLayout produced)
  rect() {
    return { x: this.root.offsetLeft, y: this.root.offsetTop, w: this.root.offsetWidth, h: this.root.offsetHeight };
  }

  // generic pointer drag: onMove(dx, dy) relative to start; onEnd(moved)
  pointerDrag(e, onMove, onEnd) {
    const el = e.currentTarget, sx = e.clientX, sy = e.clientY;
    let moved = false;
    el.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const dx = ev.clientX - sx, dy = ev.clientY - sy;
      if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return;
      moved = true;
      onMove(dx, dy);
    };
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      onEnd(moved);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  }

  // the bar drags the panel; a plain click on it toggles open / bar
  setupBarDrag() {
    this.bar.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || e.target.closest("button, select, input")) return;
      const { x, y, w, h: hh } = this.rect();
      this.pointerDrag(e, (dx, dy) => {
        this.prefs.x = clamp(x + dx, 0, window.innerWidth - w);
        this.prefs.y = clamp(y + dy, 0, window.innerHeight - hh);
        this.applyLayout();
      }, (moved) => {
        this.savePrefs();
        if (!moved) this.toggle();
      });
    });
  }

  setupResize() {
    for (const rz of this.root.querySelectorAll(".rb-rz")) {
      rz.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        const dir = rz.dataset.dir, { x, y, w, h: hh } = this.rect();
        this.pointerDrag(e, (dx, dy) => {
          const p = this.prefs;
          Object.assign(p, { x: p.x ?? x, y: p.y ?? y, w: p.w ?? w, h: p.h ?? hh });
          if (dir.includes("e")) p.w = Math.max(MIN_W, w + dx);
          if (dir.includes("s")) p.h = Math.max(MIN_H, hh + dy);
          if (dir.includes("w")) { p.w = Math.max(MIN_W, w - dx); p.x = x + w - p.w; }
          if (dir.includes("n")) { p.h = Math.max(MIN_H, hh - dy); p.y = y + hh - p.h; }
          this.applyLayout();
        }, () => this.savePrefs());
      });
    }
  }

  onKeydown(e) {
    if (e.altKey === HOTKEY.alt && !e.ctrlKey && !e.metaKey && e.code === HOTKEY.code) {
      e.preventDefault();
      this.toggle();
    } else if (e.key === "Escape" && this.menu) {
      this.closeMenu();
    }
  }

  onPaste(e) {
    const intoText = e.target.matches?.("textarea, input") && e.clipboardData?.types.includes("text/plain");
    const file = intoText ? null : imageFileFrom(e.clipboardData);
    if (file && this.currentEntry()) {
      e.preventDefault();
      this.setCover(file);
    }
  }

  // ================= status / undo =================

  setStatus(text, kind = "") {
    this.statusText.textContent = text;
    this.statusText.className = "rb-status-text" + (kind ? ` rb-${kind}` : "");
  }

  showUndo(text, undoFn) {
    clearTimeout(this.undoTimer);
    this.setStatus(text);
    const btn = h("button", { class: "rb-link-btn", text: "Undo", onclick: async () => {
      this.clearUndo();
      try { await undoFn(); } catch (err) { this.setStatus("Undo failed: " + err.message, "error"); }
    } });
    this.statusActions.replaceChildren(btn);
    this.undoTimer = setTimeout(() => this.clearUndo(), UNDO_MS);
  }

  clearUndo() {
    clearTimeout(this.undoTimer);
    this.statusActions.replaceChildren();
  }

  // ================= data loading & saving =================

  async loadProjects(selectId) {
    try {
      this.projects = await API.listProjects();
    } catch (err) {
      this.projects = [];
      this.setStatus("Could not load projects: " + err.message, "error");
    }
    const id = this.projects.some((p) => p.id === selectId) ? selectId : this.projects[0]?.id;
    await this.openProject(id);
  }

  async openProject(id) {
    this.project = null;
    this.projectError = null;
    this.history.clear();
    if (id) {
      try {
        this.project = await API.getProject(id);
      } catch (err) {
        this.projectError = { id, message: err.message };
      }
    }
    this.prefs.projectId = id || null;
    this.sel = { ...(this.project && this.prefs.sel[id]) };
    this.fixSelection();
    this.render();
  }

  async switchProject(id) {
    await this.flush();
    this.clearUndo();
    await this.openProject(id);
  }

  scheduleSave(delay = SAVE_DELAY) {
    if (!this.project) return;
    this.dirty = true;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), delay);
  }

  async flush() {
    clearTimeout(this.saveTimer);
    if (this.saving) {
      this.saveAgain = true;
      return this.saving;
    }
    // while a conflict is unresolved, keep edits in memory; the banner decides what happens to them
    if (!this.dirty || !this.project || this.conflict) return;
    this.dirty = false;
    const p = this.project;
    this.saving = (async () => {
      try {
        const meta = await API.saveProject(p, p.rev);
        p.rev = meta.rev;
        p.updatedAt = meta.updatedAt;
        const listed = this.projects.find((x) => x.id === p.id);
        if (listed) Object.assign(listed, { name: p.name, rev: p.rev, updatedAt: p.updatedAt });
        // keep a "Deleted [Undo]" message visible instead of replacing it with the save time
        if (this.project === p && !this.statusActions.childElementCount) this.setStatus(`Saved ${hhmm()}`);
      } catch (err) {
        if (this.project === p) this.dirty = true;
        if (err.status === 409 && this.project === p) this.showConflict(err.body?.rev);
        else if (err.status !== 409) this.setStatus("Save failed: " + err.message, "error");
      } finally {
        this.saving = null;
        if (this.saveAgain) {
          this.saveAgain = false;
          await this.flush();
        }
      }
    })();
    return this.saving;
  }

  // ================= other computers (shared folder) =================

  showBanner(text, actions = []) {
    this.banner.replaceChildren(h("span", { class: "rb-banner-text", text }),
      ...actions.map(([label, fn]) => h("button", { class: "rb-link-btn", text: label, onclick: fn })));
    this.banner.hidden = false;
  }

  hideBanner() {
    this.banner.hidden = true;
  }

  // a save was rejected because the file on disk is newer
  showConflict(diskRev) {
    const p = this.project;
    this.conflict = { rev: diskRev ?? p.rev };
    this.showBanner("This project was changed on another computer.", [
      ["Reload", async () => {
        this.conflict = null;
        this.dirty = false;
        this.hideBanner();
        await this.openProject(p.id);
        this.setStatus("Reloaded the latest version");
      }],
      ["Keep mine", () => {
        p.rev = this.conflict.rev;
        this.conflict = null;
        this.hideBanner();
        this.dirty = true;
        this.flush();
      }],
    ]);
  }

  // every POLL_MS and on window focus: pick up projects added/renamed elsewhere and newer versions of the open one
  async checkRemote() {
    if (document.hidden || this.checking) return;
    this.checking = true;
    try {
      const list = await API.listProjects();
      const p = this.project;
      const changed = JSON.stringify(list.map((x) => [x.id, x.name])) !== JSON.stringify(this.projects.map((x) => [x.id, x.name]));
      this.projects = list;
      if (changed) this.renderProjectSelect();
      if (!p || this.conflict) return;
      const remote = list.find((x) => x.id === p.id);
      if (!remote) {
        this.showBanner("This project was deleted or moved on another computer.", [["OK", () => this.hideBanner()]]);
        return;
      }
      if (remote.rev <= p.rev) return;
      if (this.dirty || this.saving) {
        this.showConflict(remote.rev);
        return;
      }
      // don't pull the text out from under someone who is typing or using the large editor
      const active = document.activeElement;
      if (document.querySelector(".rb-overlay") || (this.root.contains(active) && active.matches("textarea, input"))) return;
      await this.openProject(p.id);
      this.setStatus(`Updated from another computer ${hhmm()}`);
    } catch {
      // offline NAS etc.: try again next time
    } finally {
      this.checking = false;
    }
  }

  async chooseDataFolder() {
    let cfg;
    try {
      cfg = await API.getConfig();
    } catch (err) {
      this.setStatus("Could not read settings: " + err.message, "error");
      return;
    }
    if (cfg.source === "env") {
      this.setStatus(`Data folder is fixed by REFBOOK_DIR: ${cfg.vaultDir}`, "error");
      return;
    }
    const note = cfg.conflictFiles.length
      ? `\n\nIgnored sync-conflict files: ${cfg.conflictFiles.join(", ")}` : "";
    const message = `Current: ${cfg.vaultDir}\n\nEnter a full folder path, e.g. Z:\\RefBook or \\\\NAS\\share\\RefBook. ` +
      `Leave empty to use the default folder.${note}`;
    let value;
    try {
      const dlg = this.app.extensionManager?.dialog;
      value = dlg?.prompt
        ? await dlg.prompt({ title: "RefBook data folder", message, defaultValue: cfg.source === "config" ? cfg.vaultDir : "" })
        : window.prompt(message, cfg.source === "config" ? cfg.vaultDir : "");
    } catch {
      return;
    }
    if (value == null) return;
    value = String(value).trim();
    try {
      const dry = await API.setConfig({ vaultDir: value, dryRun: true });
      if (dry.vaultDir === cfg.vaultDir) return;
      let copyExisting = false;
      if (!dry.hasProjects && this.projects.length) {
        copyExisting = await this.confirm("Copy projects?",
          `The new folder has no projects yet. Copy your ${this.projects.length} project(s) and their images there? Nothing in the current folder is deleted.`);
      }
      await this.flush();
      const res = await API.setConfig({ vaultDir: value, copyExisting });
      this.hideBanner();
      this.conflict = null;
      await this.loadProjects(this.prefs.projectId);
      this.setStatus(`Data folder: ${res.vaultDir}` + (copyExisting ? ` (${res.copied} files copied)` : ""));
    } catch (err) {
      this.setStatus("Could not change folder: " + err.message, "error");
    }
  }

  // ================= selection =================

  currentSection() {
    return this.project?.sections.find((s) => s.id === this.sel.s) || null;
  }

  currentEntry() {
    return this.currentSection()?.entries.find((e) => e.id === this.sel.e) || null;
  }

  currentGroup() {
    return this.currentEntry()?.groups.find((g) => g.id === this.sel.g) || null;
  }

  // make the selection valid: fall back to the first section / entry / group
  fixSelection() {
    const p = this.project;
    if (!p) return;
    const s = p.sections.find((x) => x.id === this.sel.s) || p.sections[0];
    const e = s?.entries.find((x) => x.id === this.sel.e) || s?.entries[0];
    const g = e?.groups.find((x) => x.id === this.sel.g) || e?.groups[0];
    this.sel = { s: s?.id || null, e: e?.id || null, g: g?.id || null };
    this.prefs.sel[p.id] = this.sel;
    this.savePrefs();
  }

  choose(part, id) {
    if (part === "s") this.sel = { s: id, e: null, g: null };
    if (part === "e") this.sel = { ...this.sel, e: id, g: null };
    if (part === "g") this.sel = { ...this.sel, g: id };
    this.fixSelection();
    this.render();
  }

  findEntry(id) {
    for (const section of this.project?.sections || []) {
      const index = section.entries.findIndex((e) => e.id === id);
      if (index >= 0) return { section, entry: section.entries[index], index };
    }
    return null;
  }

  defaultGroupNames() {
    let raw = "Features, Action";
    try { raw = this.app.extensionManager?.setting?.get(DEFAULT_GROUPS_SETTING) ?? raw; } catch {}
    return String(raw).split(",").map((s) => s.trim()).filter(Boolean);
  }

  async confirm(title, message) {
    try {
      const dlg = this.app.extensionManager?.dialog;
      if (dlg?.confirm) return !!(await dlg.confirm({ title, message }));
    } catch {}
    return window.confirm(`${title}\n\n${message}`);
  }

  // ================= actions =================

  async createProject(copyFrom) {
    await this.flush();
    try {
      const name = copyFrom ? `${this.project.name} copy` : "New project";
      const p = await API.createProject(name, copyFrom);
      await this.loadProjects(p.id);
      this.setMode("open");
      this.setStatus(copyFrom ? "Project copied" : "Project created");
      this.startRename(p.id);
    } catch (err) {
      this.setStatus("Could not create project: " + err.message, "error");
    }
  }

  async deleteProject() {
    const id = this.project?.id || this.projectError?.id;
    if (!id) return;
    const name = this.project?.name || this.projects.find((p) => p.id === id)?.name || id;
    if (!(await this.confirm("Delete project", `Delete project "${name}"? (It goes to the trash and can be restored.)`))) return;
    await this.flush();
    try {
      await API.deleteProject(id);
      this.dirty = false;
      await this.loadProjects(null);
      this.showUndo(`Deleted project "${name}"`, async () => {
        await API.restoreProject(id);
        await this.loadProjects(id);
        this.setStatus("Project restored");
      });
    } catch (err) {
      this.setStatus("Delete failed: " + err.message, "error");
    }
  }

  addSection() {
    const s = { id: newId("s"), name: "New section", entries: [] };
    this.project.sections.push(s);
    this.scheduleSave();
    this.choose("s", s.id);
    this.startRename(s.id);
  }

  async deleteSection(section) {
    if (section.entries.length && !(await this.confirm("Delete section", `Section "${section.name}" has ${section.entries.length} item(s). Delete them all?`))) return;
    const list = this.project.sections, index = list.indexOf(section);
    list.splice(index, 1);
    this.afterDelete(`Deleted section "${section.name}"`, () => {
      list.splice(Math.min(index, list.length), 0, section);
      this.sel = { s: section.id };
    });
  }

  addEntry(section) {
    const e = {
      id: newId("e"), name: "New item", cover: null,
      groups: this.defaultGroupNames().map((name) => ({ id: newId("g"), name, text: "", inAll: true })),
    };
    section.entries.push(e);
    this.scheduleSave();
    this.choose("e", e.id);
    this.startRename(e.id);
  }

  deleteEntry(section, entry) {
    const index = section.entries.indexOf(entry);
    section.entries.splice(index, 1);
    this.afterDelete(`Deleted "${entry.name}"`, () => {
      if (!this.project.sections.includes(section)) return;
      section.entries.splice(Math.min(index, section.entries.length), 0, entry);
      this.sel = { s: section.id, e: entry.id };
    });
  }

  addGroup(entry) {
    const g = { id: newId("g"), name: "New group", text: "", inAll: true };
    entry.groups.push(g);
    this.scheduleSave();
    this.choose("g", g.id);
    this.startRename(g.id);
  }

  deleteGroup(entry, g) {
    const index = entry.groups.indexOf(g);
    entry.groups.splice(index, 1);
    this.afterDelete(`Deleted "${g.name}"`, () => {
      entry.groups.splice(Math.min(index, entry.groups.length), 0, g);
      this.sel = { ...this.sel, e: entry.id, g: g.id };
    });
  }

  // local soft delete: the backend snapshots removed items into .trash on save; undo re-inserts in memory
  afterDelete(label, restore) {
    const project = this.project;
    this.fixSelection();
    this.scheduleSave(0);
    this.render();
    this.showUndo(label, () => {
      if (this.project !== project) return;
      restore();
      this.fixSelection();
      this.scheduleSave(0);
      this.render();
      this.setStatus("Restored");
    });
  }

  async setCover(file, entryId) {
    const entry = entryId ? this.findEntry(entryId)?.entry : this.currentEntry();
    if (!entry) return;
    this.setStatus("Uploading image…");
    try {
      entry.cover = await API.uploadImage(file);
      this.scheduleSave(0);
      this.renderTiles();
    } catch (err) {
      this.setStatus("Image upload failed: " + err.message, "error");
    }
  }

  pickCover(entryId) {
    this.coverTarget = entryId;
    this.fileInput.click();
  }

  // ---- prompt text + Undo ----

  editText(g, text) {
    const now = Date.now();
    if (!this.burst || this.burst.g !== g.id || now - this.burst.t > HISTORY_IDLE_MS) {
      const stack = this.history.get(g.id) || [];
      if (stack.at(-1) !== g.text) stack.push(g.text);
      if (stack.length > HISTORY_MAX) stack.shift();
      this.history.set(g.id, stack);
    }
    this.burst = { g: g.id, t: now };
    g.text = text;
    this.scheduleSave();
  }

  undoText(g) {
    const stack = this.history.get(g.id);
    if (!stack?.length) return false;
    g.text = stack.pop();
    this.burst = null;
    this.scheduleSave();
    this.setStatus("Undone");
    return true;
  }

  async copy(text, btn) {
    const ok = await this.writeClipboard(text);
    const html = (btn.dataset.html ||= btn.innerHTML);
    btn.innerHTML = ok ? `${ICON_CHECK}<span>Copied</span>` : "<span>Copy failed</span>";
    btn.classList.add(ok ? "rb-ok" : "rb-bad");
    setTimeout(() => {
      btn.innerHTML = html;
      btn.classList.remove("rb-ok", "rb-bad");
    }, COPIED_MS);
  }

  async writeClipboard(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {}
    // fallback for plain-http LAN access: hidden textarea inside the panel so the copy event stays isolated
    const prev = document.activeElement;
    const ta = h("textarea", { readonly: true, style: "position:fixed;left:-9999px;top:0;opacity:0" });
    ta.value = text;
    this.root.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch {}
    ta.remove();
    prev?.focus?.({ preventScroll: true });
    return ok;
  }

  // ================= menus & inline rename =================

  showMenu(anchor, items) {
    this.closeMenu();
    const r = anchor.getBoundingClientRect();
    this.menu = h("div", { class: "rb-menu" }, items.filter(Boolean).map((it) =>
      h("button", { class: "rb-menu-item" + (it.danger ? " rb-danger" : ""), text: it.label, onclick: () => { this.closeMenu(); it.action(); } })));
    this.root.append(this.menu);
    const mw = this.menu.offsetWidth, mh = this.menu.offsetHeight;
    this.menu.style.left = clamp(r.right - mw, 4, window.innerWidth - mw - 4) + "px";
    this.menu.style.top = (r.bottom + mh + 4 > window.innerHeight ? r.top - mh - 2 : r.bottom + 2) + "px";
    this.menuCloser = (e) => { if (!this.menu?.contains(e.target)) this.closeMenu(); };
    setTimeout(() => document.addEventListener("pointerdown", this.menuCloser, true));
  }

  closeMenu() {
    this.menu?.remove();
    this.menu = null;
    document.removeEventListener("pointerdown", this.menuCloser, true);
  }

  projectMenu(anchor) {
    const has = !!this.project;
    this.showMenu(anchor, [
      { label: "New project", action: () => this.createProject() },
      has && { label: "Rename project", action: () => this.startRename(this.project.id) },
      has && { label: "Duplicate project", action: () => this.createProject(this.project.id) },
      { label: "Data folder…", action: () => this.chooseDataFolder() },
      (has || this.projectError) && { label: "Delete project", danger: true, action: () => this.deleteProject() },
    ]);
  }

  nameTarget(id) {
    const p = this.project;
    if (!p) return null;
    if (p.id === id) return p;
    for (const s of p.sections) {
      if (s.id === id) return s;
      for (const e of s.entries) {
        if (e.id === id) return e;
        for (const g of e.groups) if (g.id === id) return g;
      }
    }
    return null;
  }

  startRename(id) {
    const el = this.root.querySelector(`[data-name-of="${id}"]`);
    const obj = this.nameTarget(id);
    if (!el || !obj) return;
    const input = h("input", { class: "rb-inline-input", value: obj.name, spellcheck: "false", size: Math.max(4, charCount(obj.name) + 2) });
    let done = false;
    const finish = (commit) => {
      if (done) return;
      done = true;
      const v = input.value.trim();
      if (commit && v && v !== obj.name) {
        obj.name = v;
        this.scheduleSave();
      }
      this.render();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); finish(true); }
      else if (e.key === "Escape") { e.preventDefault(); finish(false); }
    });
    input.addEventListener("input", () => { input.size = Math.max(4, charCount(input.value) + 2); });
    input.addEventListener("blur", () => finish(true));
    for (const t of ["click", "pointerdown", "dblclick"]) input.addEventListener(t, (e) => e.stopPropagation());
    el.replaceChildren(input);
    input.focus();
    input.select();
  }

  // ================= drag & drop reorder (horizontal) =================

  dragStart(e, kind, id) {
    this.drag = { kind, id };
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData(DND_TYPE, id);
    e.stopPropagation();
  }

  dragEnd() {
    this.drag = null;
    this.clearDropMarks();
  }

  clearDropMarks() {
    for (const el of this.root.querySelectorAll(".rb-drop-before, .rb-drop-after, .rb-drop-into")) {
      el.classList.remove("rb-drop-before", "rb-drop-after", "rb-drop-into");
    }
  }

  // mode "sort": before/after by horizontal position; mode "into": drop onto the element
  bindDrop(el, accepts, mode, onDrop) {
    let pos = null;
    el.addEventListener("dragover", (e) => {
      if (!this.drag || !accepts(this.drag)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "move";
      const r = el.getBoundingClientRect();
      pos = mode === "into" ? "into" : e.clientX < r.left + r.width / 2 ? "before" : "after";
      if (!el.classList.contains(`rb-drop-${pos}`)) {
        this.clearDropMarks();
        el.classList.add(`rb-drop-${pos}`);
      }
    });
    el.addEventListener("drop", (e) => {
      if (!this.drag || !accepts(this.drag)) return;
      e.preventDefault();
      e.stopPropagation();
      const drag = this.drag;
      this.dragEnd();
      onDrop(drag, pos);
      this.scheduleSave();
      this.render();
    });
  }

  // ================= rendering =================

  render() {
    this.closeMenu();
    this.renderProjectSelect();
    this.renderSections();
    this.renderTiles();
    this.renderGroups();
    this.renderEditor();
  }

  renderProjectSelect() {
    const current = this.projects.find((p) => p.id === this.project?.id);
    if (current) current.name = this.project.name;
    this.projectSlot.dataset.nameOf = this.project?.id || "";
    this.projectSlot.replaceChildren(this.select);
    this.select.replaceChildren(...this.projects.map((p) =>
      h("option", { value: p.id, text: p.error ? `${p.name} (unreadable)` : p.name })));
    if (!this.projects.length) this.select.append(h("option", { value: "", text: "RefBook" }));
    this.select.value = this.project?.id || this.projectError?.id || "";
    this.select.disabled = !this.projects.length;
  }

  // hover badges: ✎ rename (top-left) and ✕ delete (top-right)
  badges(id, onDelete) {
    return [
      h("button", { class: "rb-edit", title: "Rename", text: "✎", onclick: (e) => { e.stopPropagation(); this.startRename(id); } }),
      h("button", { class: "rb-x", title: "Delete", text: "✕", onclick: (e) => { e.stopPropagation(); onDelete(); } }),
    ];
  }

  // a tab with rename (✎ or double-click), hover ✕ and horizontal drag reorder
  tab({ id, label, active, kind, onClick, onDelete }) {
    return h("div", {
      class: "rb-tab" + (active ? " rb-active" : ""), draggable: "true", title: "Double-click or ✎ to rename, drag to reorder",
      onclick: onClick,
      ondragstart: (e) => this.dragStart(e, kind, id),
      ondragend: () => this.dragEnd(),
    },
      h("span", { class: "rb-tab-label", dataset: { nameOf: id }, text: label,
        ondblclick: (e) => { e.stopPropagation(); this.startRename(id); } }),
      ...this.badges(id, onDelete),
    );
  }

  addTab(title, onClick) {
    return h("button", { class: "rb-tab rb-tab-add", title, text: "＋", onclick: onClick });
  }

  renderSections() {
    const p = this.project;
    if (!p) {
      this.secRow.replaceChildren();
      return;
    }
    const tabs = p.sections.map((s) => {
      const t = this.tab({ id: s.id, label: s.name, active: s.id === this.sel.s, kind: "section",
        onClick: () => this.choose("s", s.id), onDelete: () => this.deleteSection(s) });
      this.bindDrop(t, (d) => d.kind === "section" && d.id !== s.id, "sort", (d, pos) => {
        const from = p.sections.findIndex((x) => x.id === d.id);
        moveInArrays(p.sections, from, p.sections, p.sections.indexOf(s) + (pos === "after" ? 1 : 0));
      });
      // dropping an entry tile on a section tab moves it into that section
      this.bindDrop(t, (d) => d.kind === "entry", "into", (d) => {
        const src = this.findEntry(d.id);
        if (src && src.section !== s) moveInArrays(src.section.entries, src.index, s.entries, s.entries.length);
      });
      return t;
    });
    this.secRow.replaceChildren(...tabs, this.addTab("Add section", () => this.addSection()));
  }

  renderTiles() {
    const s = this.currentSection();
    if (!s) {
      this.tileRow.replaceChildren();
      this.tileRow.hidden = true;
      return;
    }
    this.tileRow.hidden = false;
    const tiles = s.entries.map((e) => {
      const active = e.id === this.sel.e;
      const img = e.cover
        ? h("img", { class: "rb-tile-img", loading: "lazy", draggable: "false", src: API.imageUrl(e.cover, "thumb") })
        : h("div", { class: "rb-tile-img rb-tile-empty", text: [...e.name].slice(0, 2).join("") });
      const box = h("div", { class: "rb-tile-box", title: active ? (e.cover ? "Click to enlarge" : "Click to upload an image") : e.name },
        img,
        ...this.badges(e.id, () => this.deleteEntry(s, e)),
        h("button", { class: "rb-tile-pic", title: "Change image (or drag & drop / Ctrl+V)", text: "🖼", onclick: (ev) => { ev.stopPropagation(); this.pickCover(e.id); } }),
      );
      const tile = h("div", {
        class: "rb-tile" + (active ? " rb-active" : ""), draggable: "true",
        onclick: () => {
          if (!active) this.choose("e", e.id);
          else if (e.cover) this.openLightbox(API.imageUrl(e.cover, "full"));
          else this.pickCover(e.id);
        },
        ondragstart: (ev) => this.dragStart(ev, "entry", e.id),
        ondragend: () => this.dragEnd(),
      },
        box,
        h("div", { class: "rb-tile-name", dataset: { nameOf: e.id }, text: e.name, title: "Double-click or ✎ to rename",
          ondblclick: (ev) => { ev.stopPropagation(); this.startRename(e.id); } }),
      );
      // image files dropped from the desktop set that tile's picture
      tile.addEventListener("dragover", (ev) => {
        if (this.drag) return;
        ev.preventDefault();
        tile.classList.add("rb-drop-into");
      });
      tile.addEventListener("dragleave", () => tile.classList.remove("rb-drop-into"));
      tile.addEventListener("drop", (ev) => {
        tile.classList.remove("rb-drop-into");
        const f = !this.drag && imageFileFrom(ev.dataTransfer);
        if (f) { ev.preventDefault(); this.setCover(f, e.id); }
      });
      this.bindDrop(tile, (d) => d.kind === "entry" && d.id !== e.id, "sort", (d, pos) => {
        const src = this.findEntry(d.id);
        moveInArrays(src.section.entries, src.index, s.entries, s.entries.indexOf(e) + (pos === "after" ? 1 : 0));
      });
      return tile;
    });
    const add = h("div", { class: "rb-tile rb-tile-add", title: "Add item", onclick: () => this.addEntry(s) },
      h("div", { class: "rb-tile-box" }, h("div", { class: "rb-tile-img rb-tile-empty", text: "＋" })),
      h("div", { class: "rb-tile-name", text: "Add" }));
    this.tileRow.replaceChildren(...tiles, add);
  }

  renderGroups() {
    const e = this.currentEntry();
    if (!e) {
      this.groupRow.replaceChildren();
      this.groupRow.hidden = true;
      return;
    }
    this.groupRow.hidden = false;
    const tabs = e.groups.map((g) => {
      const t = this.tab({ id: g.id, label: g.name, active: g.id === this.sel.g, kind: "group",
        onClick: () => this.choose("g", g.id), onDelete: () => this.deleteGroup(e, g) });
      this.bindDrop(t, (d) => d.kind === "group" && d.id !== g.id, "sort", (d, pos) => {
        const from = e.groups.findIndex((x) => x.id === d.id);
        if (from >= 0) moveInArrays(e.groups, from, e.groups, e.groups.indexOf(g) + (pos === "after" ? 1 : 0));
      });
      return t;
    });
    this.groupRow.replaceChildren(...tabs, this.addTab("Add prompt group", () => this.addGroup(e)));
  }

  renderEditor() {
    const ed = this.editor;
    if (this.projectError) {
      ed.replaceChildren(h("div", { class: "rb-placeholder rb-error" },
        h("div", { text: "This project file could not be read. Other projects are not affected." }),
        h("div", { class: "rb-mono", text: this.projectError.message }),
        h("div", { text: `Earlier versions are kept in .backups/${this.projectError.id}/ in the vault folder.` })));
      return;
    }
    if (!this.project) {
      ed.replaceChildren(h("div", { class: "rb-placeholder" },
        h("button", { class: "rb-big-btn", text: "Create your first project", onclick: () => this.createProject() })));
      return;
    }
    const g = this.currentGroup();
    if (!g) {
      const hint = !this.currentSection() ? "Click ＋ to add a section" : !this.currentEntry() ? "Click ＋ to add an item" : "Click ＋ to add a prompt group";
      ed.replaceChildren(h("div", { class: "rb-placeholder", text: hint }));
      return;
    }
    const expandBtn = h("button", { class: "rb-tool-btn rb-icon-only", title: "Open in a large editor", html: ICON_EXPAND,
      onclick: () => this.openPromptViewer(g) });
    ed.replaceChildren(...this.promptEditor(g, [expandBtn]));
  }

  // toolbar (char count, Undo, Copy, extras) + textarea for one group; used inline and in the large editor
  promptEditor(g, extraButtons = [], label = null) {
    const count = h("span", { class: "rb-count" });
    const undoBtn = h("button", { class: "rb-tool-btn", title: "Undo the last edit", html: `${ICON_UNDO}<span>Undo</span>`,
      onclick: () => { if (this.undoText(g)) sync(); } });
    const ta = h("textarea", { class: "rb-prompt", spellcheck: "false", placeholder: "Type or paste a prompt here. Changes save automatically…" });
    const sync = () => {
      ta.value = g.text;
      count.textContent = `${charCount(g.text)} chars`;
      undoBtn.disabled = !this.history.get(g.id)?.length;
    };
    ta.addEventListener("input", () => {
      this.editText(g, ta.value);
      count.textContent = `${charCount(g.text)} chars`;
      undoBtn.disabled = false;
    });
    sync();
    const tools = h("div", { class: "rb-editor-tools" },
      label, count,
      h("div", { class: "rb-flex" }),
      undoBtn,
      h("button", { class: "rb-tool-btn rb-primary", title: "Copy this prompt", html: `${ICON_COPY}<span>Copy</span>`,
        onclick: (e) => this.copy(g.text, e.currentTarget) }),
      ...extraButtons);
    return [tools, ta];
  }

  // large editor for long prompts; edits save the same way, ✕ / Esc / clicking outside closes it
  openPromptViewer(g) {
    const entry = this.currentEntry();
    const close = () => {
      box.remove();
      this.renderEditor();
      this.root.focus({ preventScroll: true });
    };
    const closeBtn = h("button", { class: "rb-tool-btn rb-icon-only", title: "Close (Esc)", text: "✕", onclick: close });
    const label = h("span", { class: "rb-viewer-title", text: `${entry?.name ?? ""} · ${g.name}` });
    const [tools, ta] = this.promptEditor(g, [closeBtn], label);
    const box = h("div", { class: "rb-overlay", tabindex: "-1",
      onclick: (e) => { if (e.target === box) close(); },
      onkeydown: (e) => { if (e.key === "Escape") close(); } },
      h("div", { class: "rb-viewer" }, tools, ta));
    isolate(box);
    document.body.append(box);
    ta.focus({ preventScroll: true });
  }

  openLightbox(src) {
    const close = () => {
      box.remove();
      this.root.focus({ preventScroll: true });
    };
    const box = h("div", { class: "rb-lightbox", tabindex: "-1", onclick: close,
      onkeydown: (e) => { if (e.key === "Escape") close(); } },
      h("img", { src, draggable: "false" }));
    isolate(box);
    document.body.append(box);
    box.focus();
  }
}
