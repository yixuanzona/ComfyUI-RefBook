// Thin fetch wrapper for /refbook/api. Uses ComfyUI's api.fetchApi so requests go through /api/...
import { api } from "../../scripts/api.js";

const BASE = "/refbook/api";

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error || `HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

async function call(method, path, body) {
  const opts = { method };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) {
    opts.body = JSON.stringify(body);
    opts.headers = { "Content-Type": "application/json" };
  }
  const res = await api.fetchApi(BASE + path, opts);
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

export const listProjects = () => call("GET", "/projects").then((d) => d.projects);
export const createProject = (name, copyFrom) => call("POST", "/projects", copyFrom ? { name, copyFrom } : { name });
export const getProject = (id) => call("GET", `/projects/${id}`);
export const saveProject = (project, baseRev) => call("PUT", `/projects/${project.id}`, { project, baseRev });
export const deleteProject = (id) => call("DELETE", `/projects/${id}`);
export const restoreProject = (id) => call("POST", "/trash/restore", { kind: "project", id });

export const getConfig = () => call("GET", "/config");
export const setConfig = (body) => call("PUT", "/config", body);

// kind "cover" is re-encoded small; kind "ref" keeps the original image
export function uploadImage(file, kind = "cover") {
  const fd = new FormData();
  fd.append("kind", kind);
  fd.append("image", file, file.name || "image.png");
  return call("POST", "/images", fd).then((d) => d.imageId);
}

export const imageUrl = (id, size = "full") => api.apiURL(`${BASE}/images/${id}?size=${size}`);

// copy an image into ComfyUI's input folder (ComfyUI's own upload API) and return the name Load Image uses
export async function uploadToComfyInput(blob, filename) {
  const fd = new FormData();
  fd.append("image", blob, filename);
  fd.append("overwrite", "true");
  const res = await api.fetchApi("/upload/image", { method: "POST", body: fd });
  if (!res.ok) throw new ApiError(res.status, { error: await res.text() });
  const d = await res.json();
  return d.subfolder ? `${d.subfolder}/${d.name}` : d.name;
}
