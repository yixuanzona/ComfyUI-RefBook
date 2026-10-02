"""aiohttp routes under /refbook/api, registered on ComfyUI's PromptServer route table."""
import asyncio
import logging
import os

from aiohttp import web

import folder_paths
from server import PromptServer

from .store import IMAGE_MAX_BYTES, Vault, VaultError

PREFIX = "/refbook/api"
routes = PromptServer.instance.routes
write_lock = asyncio.Lock()


def vault():
    # Phase 1: fixed default location under ComfyUI/user/default/
    return Vault(os.path.join(folder_paths.get_user_directory(), "default", "ref_book"))


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
    reader = await request.multipart()
    field = await reader.next()
    while field is not None and field.name != "image":
        field = await reader.next()
    if field is None:
        raise VaultError("multipart field 'image' is required")
    data = bytearray()
    while chunk := await field.read_chunk(1 << 16):
        data += chunk
        if len(data) > IMAGE_MAX_BYTES:
            return err(413, "image larger than 20 MB")
    iid = await asyncio.to_thread(vault().save_image, bytes(data))
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
    return web.json_response({"vaultDir": vault().root})
