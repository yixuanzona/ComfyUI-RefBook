"""aiohttp routes under /refbook/api, registered on ComfyUI's PromptServer route table."""
import asyncio
import json
import logging
import os

from aiohttp import web

import folder_paths
from server import PromptServer

from .store import IMAGE_MAX_BYTES, REF_MAX_BYTES, Vault, VaultError, atomic_write_bytes, dump_json

PREFIX = "/refbook/api"
ENV_DIR = "REFBOOK_DIR"
routes = PromptServer.instance.routes
write_lock = asyncio.Lock()


def default_dir():
    return os.path.join(folder_paths.get_user_directory(), "default", "ref_book")


def config_path():
    # per computer, outside the vault: two machines may reach the same NAS folder by different paths
    return os.path.join(folder_paths.get_user_directory(), "default", "ref_book_config.json")


def vault_dir():
    """(folder, source) where source is 'env', 'config' or 'default'."""
    if os.environ.get(ENV_DIR):
        return os.path.abspath(os.environ[ENV_DIR]), "env"
    try:
        with open(config_path(), "r", encoding="utf-8") as f:
            configured = json.load(f).get("vaultDir")
        if configured:
            return configured, "config"
    except (OSError, ValueError, AttributeError):
        pass
    return default_dir(), "default"


def vault():
    return Vault(vault_dir()[0])


def check_folder(path):
    """A vault folder must be an existing, writable, absolute directory (e.g. Z:\\RefBook or \\\\nas\\share\\RefBook)."""
    if not isinstance(path, str) or not path.strip():
        raise VaultError("folder path is empty")
    path = os.path.normpath(path.strip().strip('"'))
    if not os.path.isabs(path):
        raise VaultError("please enter a full path, e.g. Z:\\RefBook or \\\\NAS\\share\\RefBook")
    if not os.path.isdir(path):
        raise VaultError(f"folder not found: {path}")
    probe = os.path.join(path, f".refbook-write-test-{os.getpid()}")
    try:
        with open(probe, "w") as f:
            f.write("ok")
        os.remove(probe)
    except OSError as e:
        raise VaultError(f"folder is not writable: {e}")
    return path


def config_payload():
    folder, source = vault_dir()
    v = Vault(folder)
    try:
        conflicts = v.conflict_files()
    except OSError:
        conflicts = []
    return {"vaultDir": folder, "defaultDir": default_dir(), "source": source, "conflictFiles": conflicts}


def err(status, message, **extra):
    return web.json_response({"error": message, **extra}, status=status)


def handle_errors(fn):
    async def wrapper(request):
        try:
            return await fn(request)
        except VaultError as e:
            return err(e.status, str(e), **({"rev": e.rev} if hasattr(e, "rev") else {}))
        except Exception as e:
            logging.exception("[RefBook] %s %s failed", request.method, request.path)
            return err(500, f"{type(e).__name__}: {e}")
    return wrapper


async def json_body(request):
    try:
        data = await request.json()
    except Exception:
        raise VaultError("invalid JSON body")
    if not isinstance(data, dict):
        raise VaultError("JSON body must be an object")
    return data


@routes.get(PREFIX + "/projects")
@handle_errors
async def list_projects(request):
    return web.json_response({"projects": vault().list_projects()})


@routes.post(PREFIX + "/projects")
@handle_errors
async def create_project(request):
    body = await json_body(request)
    async with write_lock:
        project = vault().create_project(body.get("name"), copy_from=body.get("copyFrom"))
    return web.json_response(project)


@routes.get(PREFIX + "/projects/{id}")
@handle_errors
async def get_project(request):
    return web.json_response(vault().get_project(request.match_info["id"]))


@routes.put(PREFIX + "/projects/{id}")
@handle_errors
async def put_project(request):
    body = await json_body(request)
    try:
        base_rev = int(body.get("baseRev"))
    except (TypeError, ValueError):
        raise VaultError("baseRev is required")
    async with write_lock:
        meta = vault().save_project(request.match_info["id"], body.get("project"), base_rev)
    return web.json_response(meta)


@routes.delete(PREFIX + "/projects/{id}")
@handle_errors
async def delete_project(request):
    async with write_lock:
        vault().delete_project(request.match_info["id"])
    return web.json_response({"ok": True})


@routes.post(PREFIX + "/trash/restore")
@handle_errors
async def restore(request):
    body = await json_body(request)
    if body.get("kind", "project") != "project":
        raise VaultError("only kind=project can be restored here; items are restored by the panel's undo")
    async with write_lock:
        meta = vault().restore_project(body.get("id"))
    return web.json_response(meta)


@routes.post(PREFIX + "/images")
@handle_errors
async def upload_image(request):
    """Multipart: optional 'kind' ('cover' default, or 'ref' to keep the original), then 'image'."""
    reader = await request.multipart()
    kind = "cover"
    field = await reader.next()
    while field is not None and field.name != "image":
        if field.name == "kind":
            kind = (await field.text()).strip()
        field = await reader.next()
    if field is None:
        raise VaultError("multipart field 'image' is required")
    limit = REF_MAX_BYTES if kind == "ref" else IMAGE_MAX_BYTES
    data = bytearray()
    while chunk := await field.read_chunk(1 << 16):
        data += chunk
        if len(data) > limit:
            return err(413, f"image larger than {limit // (1024 * 1024)} MB")
    v = vault()
    iid = await asyncio.to_thread(v.save_ref if kind == "ref" else v.save_image, bytes(data))
    return web.json_response({"imageId": iid})


@routes.get(PREFIX + "/images/{id}")
@handle_errors
async def get_image(request):
    size = request.query.get("size", "full")
    path = await asyncio.to_thread(vault().image_path, request.match_info["id"], size)
    # image ids are never reused, so the files are immutable
    return web.FileResponse(path, headers={"Cache-Control": "public, max-age=31536000, immutable"})


@routes.get(PREFIX + "/config")
@handle_errors
async def get_config(request):
    return web.json_response(config_payload())


@routes.put(PREFIX + "/config")
@handle_errors
async def put_config(request):
    """Body: {vaultDir, dryRun?, copyExisting?}. Empty vaultDir resets to the default folder.
    dryRun only validates and reports whether the target already has projects."""
    body = await json_body(request)
    if vault_dir()[1] == "env":
        raise VaultError(f"the folder is fixed by the {ENV_DIR} environment variable")
    raw = (body.get("vaultDir") or "").strip()
    target = await asyncio.to_thread(check_folder, raw) if raw else default_dir()
    if body.get("dryRun"):
        return web.json_response({"vaultDir": target, "hasProjects": await asyncio.to_thread(Vault(target).has_projects)})
    async with write_lock:
        copied = 0
        if body.get("copyExisting"):
            copied = await asyncio.to_thread(vault().copy_into, target)
        if raw:
            os.makedirs(os.path.dirname(config_path()), exist_ok=True)
            atomic_write_bytes(config_path(), dump_json({"vaultDir": target}))
        elif os.path.exists(config_path()):
            os.remove(config_path())
    return web.json_response({**config_payload(), "copied": copied})
