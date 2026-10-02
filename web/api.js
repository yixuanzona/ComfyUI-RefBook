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

export function uploadImage(file) {
  const fd = new FormData();
  fd.append("image", file, file.name || "image.png");
  return call("POST", "/images", fd).then((d) => d.imageId);
}

export const imageUrl = (id, size = "full") => api.apiURL(`${BASE}/images/${id}?size=${size}`);
