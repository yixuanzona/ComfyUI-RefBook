"""Vault storage: project JSON files, images, backups and trash. Pure file IO, no ComfyUI imports."""
import copy
import io
import json
import os
import re
import secrets
import shutil
import string
import time
from datetime import datetime

ID_RE = re.compile(r"^[a-z]_[a-z0-9]{4,12}$")
PROJECT_FILE_RE = re.compile(r"^(.*)__([a-z]_[a-z0-9]{4,12})\.json$")
SCHEMA = 1
BACKUP_KEEP = 20
DEFAULT_SECTIONS = ["Character", "Background", "Style"]
IMAGE_FORMATS = {"PNG", "JPEG", "WEBP", "GIF", "BMP"}
IMAGE_MAX_BYTES = 20 * 1024 * 1024
IMAGE_FULL_EDGE = 1280
IMAGE_THUMB_EDGE = 256


class VaultError(Exception):
    status = 400


class NotFound(VaultError):
    status = 404


class Conflict(VaultError):
    status = 409

    def __init__(self, rev):
        super().__init__(f"project on disk is newer (rev {rev})")
        self.rev = rev


class BrokenProject(VaultError):
    status = 422


def new_id(prefix):
    alphabet = string.ascii_lowercase + string.digits
    return prefix + "_" + "".join(secrets.choice(alphabet) for _ in range(6))


def check_id(value):
    if not isinstance(value, str) or not ID_RE.match(value):
        raise VaultError(f"invalid id: {value!r}")
    return value


def now_iso():
    return datetime.now().astimezone().isoformat(timespec="seconds")


def slugify(name):
    s = re.sub(r"[\W_]+", "-", name.strip().lower()).strip("-")  # \W is unicode-aware: 正片 stays
    return s[:40] or "project"


def _str(value, field):
    if not isinstance(value, str):
        raise VaultError(f"{field} must be a string")
    return value


def _with_extras(src, known):
    """Known keys first in a fixed order, then any keys this version doesn't know (sorted).
    Keeping unknown keys lets an older RefBook on another computer save without wiping newer fields."""
    for k in sorted(src):
        if k not in known:
            known[k] = src[k]
    return known


def normalize_project(data):
    """Validate a project dict and rebuild it with a fixed key order (readable git diffs)."""
    if not isinstance(data, dict):
        raise VaultError("project must be an object")
    sections = []
    for s in data.get("sections") or []:
        entries = []
        for e in s.get("entries") or []:
            groups = []
            for g in e.get("groups") or []:
                groups.append(_with_extras(g, {
                    "id": check_id(g.get("id")),
                    "name": _str(g.get("name", ""), "group.name"),
                    "text": _str(g.get("text", ""), "group.text"),
                    "inAll": bool(g.get("inAll", True)),
                }))
            cover = e.get("cover")
            entries.append(_with_extras(e, {
                "id": check_id(e.get("id")),
                "name": _str(e.get("name", ""), "entry.name"),
                "cover": check_id(cover) if cover else None,
                "groups": groups,
            }))
        sections.append(_with_extras(s, {
            "id": check_id(s.get("id")),
            "name": _str(s.get("name", ""), "section.name"),
            "entries": entries,
        }))
    return _with_extras(data, {
        "schema": SCHEMA,
        "id": check_id(data.get("id")),
        "name": _str(data.get("name", ""), "project.name"),
        "rev": int(data.get("rev") or 0),
        "updatedAt": _str(data.get("updatedAt") or now_iso(), "updatedAt"),
        "sections": sections,
    })


def covers_of(project):
    return {e["cover"] for s in project["sections"] for e in s["entries"] if e.get("cover")}


def atomic_write_bytes(path, data):
    tmp = os.path.join(os.path.dirname(path), f".tmp-{os.getpid()}-{secrets.token_hex(4)}-{os.path.basename(path)}")
    with open(tmp, "wb") as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
    for attempt in range(5):  # sync clients on Windows may briefly lock the target
        try:
            os.replace(tmp, path)
            return
        except PermissionError:
            if attempt == 4:
                os.remove(tmp)
                raise
            time.sleep(0.1 * (attempt + 1))


def dump_json(obj):
    return (json.dumps(obj, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


class Vault:
    def __init__(self, root):
        self.root = root

    def _dir(self, *parts):
        path = os.path.join(self.root, *parts)
        os.makedirs(path, exist_ok=True)
        return path

    # ---------- projects ----------

    def _project_files(self):
        """Yield (project_id, filename, readable_part). Sync-conflict copies don't match the pattern and are skipped."""
        for fn in sorted(os.listdir(self._dir("projects"))):
            m = PROJECT_FILE_RE.match(fn)
            if m:
                yield m.group(2), fn, m.group(1)

    def conflict_files(self):
        """JSON files in projects/ we ignore, e.g. 'name__p_x (conflicted copy).json' made by sync tools."""
        return [fn for fn in sorted(os.listdir(self._dir("projects")))
                if fn.lower().endswith(".json") and not fn.startswith(".tmp-") and not PROJECT_FILE_RE.match(fn)]

    def has_projects(self):
        return os.path.isdir(os.path.join(self.root, "projects")) and any(True for _ in self._project_files())

    def copy_into(self, target_root):
        """Copy projects and images into another vault folder, never overwriting files already there."""
        copied = 0
        for sub in ("projects", "images", "thumbs"):
            src = os.path.join(self.root, sub)
            if not os.path.isdir(src):
                continue
            dst = os.path.join(target_root, sub)
            os.makedirs(dst, exist_ok=True)
            for fn in os.listdir(src):
                if fn.startswith(".tmp-") or os.path.exists(os.path.join(dst, fn)):
                    continue
                shutil.copy2(os.path.join(src, fn), os.path.join(dst, fn))
                copied += 1
        return copied

    def _path_of(self, pid):
        check_id(pid)
        for p, fn, _ in self._project_files():
            if p == pid:
                return os.path.join(self.root, "projects", fn)
        raise NotFound(f"project {pid} not found")

    def _read(self, path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                return normalize_project(json.load(f))
        except (ValueError, VaultError, AttributeError, TypeError) as e:
            raise BrokenProject(f"{os.path.basename(path)}: {e}")

    def list_projects(self):
        out = []
        for pid, fn, readable in self._project_files():
            try:
                p = self._read(os.path.join(self.root, "projects", fn))
                out.append({"id": pid, "name": p["name"], "rev": p["rev"], "updatedAt": p["updatedAt"]})
            except BrokenProject as e:
                out.append({"id": pid, "name": readable, "rev": 0, "updatedAt": None, "error": str(e)})
        out.sort(key=lambda x: x["name"].lower())
        return out

    def get_project(self, pid):
        return self._read(self._path_of(pid))

    def _write_project(self, project, old_path=None):
        fn = f"{slugify(project['name'])}__{project['id']}.json"
        path = os.path.join(self._dir("projects"), fn)
        atomic_write_bytes(path, dump_json(project))
        if old_path and os.path.abspath(old_path) != os.path.abspath(path) and os.path.exists(old_path):
            os.remove(old_path)  # renamed project -> filename changed

    def create_project(self, name, copy_from=None):
        name = _str(name or "", "name").strip() or "New project"
        if copy_from:
            project = copy.deepcopy(self.get_project(copy_from))
        else:
            project = {"sections": [{"id": new_id("s"), "name": n, "entries": []} for n in DEFAULT_SECTIONS]}
        project.update({"id": new_id("p"), "name": name, "rev": 1, "updatedAt": now_iso()})
        project = normalize_project(project)
        self._write_project(project)
        return project

    def save_project(self, pid, data, base_rev):
        path = self._path_of(pid)
        try:
            old = self._read(path)
        except BrokenProject:
            old = None  # a broken file may be overwritten; it is backed up first
        cur_rev = old["rev"] if old else 0
        if old and cur_rev > int(base_rev):
            raise Conflict(cur_rev)
        new = normalize_project(dict(data, id=pid))
        new["rev"] = max(cur_rev, int(base_rev)) + 1
        new["updatedAt"] = now_iso()
        self._backup(pid, path)
        self._restore_images(covers_of(new))
        self._write_project(new, old_path=path)
        if old:
            self._trash_removed_items(old, new)
            self._trash_orphan_images(covers_of(old) - covers_of(new))
        return {"id": pid, "rev": new["rev"], "updatedAt": new["updatedAt"]}

    def delete_project(self, pid):
        path = self._path_of(pid)
        dst = os.path.join(self._dir(".trash", "projects"), f"{int(time.time() * 1000)}__{os.path.basename(path)}")
        shutil.move(path, dst)

    def restore_project(self, pid):
        check_id(pid)
        tdir = self._dir(".trash", "projects")
        hits = sorted(fn for fn in os.listdir(tdir) if fn.endswith(f"__{pid}.json"))
        if not hits:
            raise NotFound(f"project {pid} not in trash")
        if any(p == pid for p, _, _ in self._project_files()):
            raise VaultError(f"project {pid} already exists")
        latest = hits[-1]
        dst = os.path.join(self._dir("projects"), latest.split("__", 1)[1])
        shutil.move(os.path.join(tdir, latest), dst)
        p = self._read(dst)
        return {"id": pid, "name": p["name"], "rev": p["rev"], "updatedAt": p["updatedAt"]}

    def _backup(self, pid, path):
        bdir = self._dir(".backups", pid)
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
        shutil.copy2(path, os.path.join(bdir, f"{stamp}.json"))
        backups = sorted(os.listdir(bdir))
        for fn in backups[:-BACKUP_KEEP]:
            os.remove(os.path.join(bdir, fn))

    def _trash_removed_items(self, old, new):
        """Snapshot sections / entries / groups that disappeared in this save into .trash/items/."""
        new_s = {s["id"] for s in new["sections"]}
        new_e = {e["id"] for s in new["sections"] for e in s["entries"]}
        new_g = {g["id"] for s in new["sections"] for e in s["entries"] for g in e["groups"]}
        removed = []
        for si, s in enumerate(old["sections"]):
            if s["id"] not in new_s:
                removed.append(("section", None, si, s))
                continue
            for ei, e in enumerate(s["entries"]):
                if e["id"] not in new_e:
                    removed.append(("entry", s["id"], ei, e))
                    continue
                for gi, g in enumerate(e["groups"]):
                    if g["id"] not in new_g:
                        removed.append(("group", e["id"], gi, g))
        if not removed:
            return
        tdir = self._dir(".trash", "items")
        stamp = int(time.time() * 1000)
        for kind, parent, index, item in removed:
            snap = {"kind": kind, "projectId": old["id"], "parentId": parent, "index": index,
                    "deletedAt": now_iso(), "item": item}
            atomic_write_bytes(os.path.join(tdir, f"{stamp}__{old['id']}__{item['id']}.json"), dump_json(snap))

    # ---------- images ----------

    def _image_paths(self, iid, trashed=False):
        base = (self.root, ".trash") if trashed else (self.root,)
        return os.path.join(*base, "images", f"{iid}.webp"), os.path.join(*base, "thumbs", f"{iid}.webp")

    def _all_covers(self):
        refs = set()
        for pid, fn, _ in self._project_files():
            try:
                refs |= covers_of(self._read(os.path.join(self.root, "projects", fn)))
            except BrokenProject:
                pass
        return refs

    def _trash_orphan_images(self, candidates):
        if not candidates:
            return
        candidates = candidates - self._all_covers()
        for iid in candidates:
            for src, dst in zip(self._image_paths(iid), self._image_paths(iid, trashed=True)):
                if os.path.exists(src):
                    os.makedirs(os.path.dirname(dst), exist_ok=True)
                    shutil.move(src, dst)

    def _restore_images(self, covers):
        """Undo may re-reference an image that was moved to trash: bring it back."""
        for iid in covers:
            full, thumb = self._image_paths(iid)
            tfull, tthumb = self._image_paths(iid, trashed=True)
            if not os.path.exists(full) and os.path.exists(tfull):
                self._dir("images")
                shutil.move(tfull, full)
                if os.path.exists(tthumb) and not os.path.exists(thumb):
                    self._dir("thumbs")
                    shutil.move(tthumb, thumb)

    def save_image(self, data):
        from PIL import Image, ImageOps
        if len(data) > IMAGE_MAX_BYTES:
            raise VaultError("image larger than 20 MB")
        try:
            img = Image.open(io.BytesIO(data))
            fmt = img.format
            img.load()
        except Exception:
            raise VaultError("not a readable image")
        if fmt not in IMAGE_FORMATS:
            raise VaultError(f"unsupported image format: {fmt}")
        img = ImageOps.exif_transpose(img)
        if img.mode in ("RGBA", "LA", "P"):
            img = img.convert("RGBA")
            bg = Image.new("RGB", img.size, (255, 255, 255))
            bg.paste(img, mask=img.getchannel("A"))
            img = bg
        img = img.convert("RGB")
        img.thumbnail((IMAGE_FULL_EDGE, IMAGE_FULL_EDGE), Image.LANCZOS)
        iid = new_id("i")
        full, _ = self._image_paths(iid)
        self._dir("images")
        buf = io.BytesIO()
        img.save(buf, "WEBP", quality=90)
        atomic_write_bytes(full, buf.getvalue())
        self._make_thumb(iid, img)
        return iid

    def _make_thumb(self, iid, img=None):
        from PIL import Image
        full, thumb = self._image_paths(iid)
        if img is None:
            img = Image.open(full)
        img = img.copy()
        img.thumbnail((IMAGE_THUMB_EDGE, IMAGE_THUMB_EDGE), Image.LANCZOS)
        self._dir("thumbs")
        buf = io.BytesIO()
        img.convert("RGB").save(buf, "WEBP", quality=85)
        atomic_write_bytes(thumb, buf.getvalue())

    def image_path(self, iid, size="full"):
        check_id(iid)
        full, thumb = self._image_paths(iid)
        if not os.path.exists(full):
            raise NotFound(f"image {iid} not found")
        if size != "thumb":
            return full
        if not os.path.exists(thumb):
            self._make_thumb(iid)
        return thumb
