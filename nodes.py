"""RefBook nodes (V3 API): output the current prompt / reference image from the RefBook folder.

Each node stores a "ref" (JSON written by the frontend picker): ids plus a readable name path.
At run time the node reads the vault, so edits in RefBook show up on the next run.
"""
import hashlib
import json
import logging
import os
import shutil
import sys

import numpy as np
import torch
from PIL import Image, ImageOps
from typing_extensions import override

import comfy.model_management
import folder_paths
from comfy_api.latest import ComfyExtension, io

from .server.routes import vault
from .server.store import ID_RE, VaultError


def _parse(ref):
    try:
        data = json.loads(ref) if ref else {}
    except ValueError:
        data = {}
    return data if isinstance(data, dict) else {}


def _console_safe(text):
    """Windows consoles (e.g. cp950) can't print every character; an unprintable error message
    breaks ComfyUI's error reporting, so replace what the console can't encode."""
    enc = getattr(sys.stderr, "encoding", None) or "utf-8"
    try:
        return text.encode(enc, "replace").decode(enc)
    except LookupError:
        return text


def _label(data):
    return _console_safe(" / ".join(str(x) for x in (data.get("path") or []) if x) or "(nothing selected)")


def _cache_dir():
    # per computer: last image that loaded fine, used when the shared folder can't be reached
    path = os.path.join(folder_paths.get_user_directory(), "default", "ref_book_cache")
    os.makedirs(path, exist_ok=True)
    return path


class RefBookPrompt(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="RefBookPrompt",
            display_name="RefBook Prompt",
            category="RefBook",
            description="Outputs the current text of a RefBook prompt group. Edits in RefBook are picked up on the next run.",
            search_aliases=["refbook", "prompt library", "character prompt"],
            inputs=[
                io.String.Input("ref", default="", socketless=True),
                # last text that resolved; used if the RefBook entry can't be found (e.g. folder not synced yet)
                io.String.Input("snapshot", default="", multiline=True, socketless=True),
            ],
            outputs=[io.String.Output("prompt", display_name="prompt")],
        )

    @classmethod
    def _text(cls, ref, snapshot):
        data = _parse(ref)
        if not data:
            raise ValueError("RefBook Prompt: click the node's button to pick a prompt group")
        try:
            return vault().resolve(data)[2]["text"]
        except (VaultError, OSError) as e:
            if snapshot:
                logging.warning("[RefBook] %s: %s. Using the last saved text.", _label(data), _console_safe(str(e)))
                return snapshot
            raise ValueError(f"RefBook Prompt: {_label(data)}: {_console_safe(str(e))}")

    @classmethod
    def fingerprint_inputs(cls, ref, snapshot):
        try:
            return hashlib.sha256(cls._text(ref, snapshot).encode("utf-8")).hexdigest()
        except ValueError as e:
            return str(e)

    @classmethod
    def execute(cls, ref, snapshot):
        text = cls._text(ref, snapshot)
        return io.NodeOutput(text, ui={"refbook_text": [text]})


class RefBookImage(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="RefBookImage",
            display_name="RefBook Image",
            category="RefBook",
            description="Outputs the current version of a RefBook reference image (full quality). "
                        "Replacing the image in RefBook updates it on the next run.",
            search_aliases=["refbook", "reference image", "character sheet"],
            inputs=[io.String.Input("ref", default="", socketless=True)],
            outputs=[io.Image.Output("IMAGE"), io.Mask.Output("MASK")],
        )

    @classmethod
    def _source(cls, ref):
        """Path of the image to load: the vault original, or the local cached copy as a fallback."""
        data = _parse(ref)
        if not data:
            raise ValueError("RefBook Image: click the node's button to pick a reference image")
        slot = data.get("r") if isinstance(data.get("r"), str) and ID_RE.match(data["r"]) else None
        cached = [os.path.join(_cache_dir(), fn) for fn in os.listdir(_cache_dir())
                  if slot and os.path.splitext(fn)[0] == slot]
        try:
            v = vault()
            src = v.image_path(v.resolve(data)[2]["image"])
        except (VaultError, OSError) as e:
            if cached:
                logging.warning("[RefBook] %s: %s. Using the last loaded copy.", _label(data), _console_safe(str(e)))
                return cached[0]
            raise ValueError(f"RefBook Image: {_label(data)}: {_console_safe(str(e))}")
        if slot:
            dst = os.path.join(_cache_dir(), slot + os.path.splitext(src)[1])
            try:
                if not os.path.exists(dst) or os.path.getsize(dst) != os.path.getsize(src) \
                        or os.path.getmtime(dst) < os.path.getmtime(src):
                    for old in cached:
                        os.remove(old)
                    shutil.copy2(src, dst)
            except OSError as e:
                logging.warning("[RefBook] could not update the local copy of %s: %s", _label(data), _console_safe(str(e)))
        return src

    @classmethod
    def fingerprint_inputs(cls, ref):
        try:
            src = cls._source(ref)
            return f"{src}|{os.path.getsize(src)}|{os.path.getmtime(src)}"
        except (ValueError, OSError) as e:
            return str(e)

    @classmethod
    def execute(cls, ref):
        img = ImageOps.exif_transpose(Image.open(cls._source(ref)))
        if img.mode in ("P", "PA", "LA") or "transparency" in img.info:
            img = img.convert("RGBA")
        dtype = comfy.model_management.intermediate_dtype()
        device = comfy.model_management.intermediate_device()
        image = torch.from_numpy(np.array(img.convert("RGB")).astype(np.float32) / 255.0)[None,]
        if "A" in img.getbands():
            mask = 1.0 - torch.from_numpy(np.array(img.getchannel("A")).astype(np.float32) / 255.0)
        else:
            mask = torch.zeros((64, 64), dtype=torch.float32)  # same as Load Image when there is no alpha
        return io.NodeOutput(image.to(device=device, dtype=dtype), mask.unsqueeze(0).to(device=device, dtype=dtype))


class RefBookExtension(ComfyExtension):
    @override
    async def get_node_list(self) -> list[type[io.ComfyNode]]:
        return [RefBookPrompt, RefBookImage]


async def comfy_entrypoint() -> RefBookExtension:
    return RefBookExtension()
