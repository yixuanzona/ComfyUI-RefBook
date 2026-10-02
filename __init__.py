"""ComfyUI-RefBook: floating panel for managing character prompts."""
from .server import routes  # noqa: F401  registers /refbook/api/* on import

# No nodes yet (phase 3). Defined so ComfyUI loads the package and serves WEB_DIRECTORY.
NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
