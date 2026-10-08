"""ComfyUI-RefBook: floating panel for an IP's reusable prompts and reference images, plus RefBook nodes."""
from .server import routes  # noqa: F401  registers /refbook/api/* on import
from .nodes import comfy_entrypoint  # V3 node registration (RefBook Prompt / RefBook Image)

WEB_DIRECTORY = "./web"

# No NODE_CLASS_MAPPINGS on purpose: ComfyUI only uses comfy_entrypoint when it is absent.
__all__ = ["WEB_DIRECTORY", "comfy_entrypoint"]
