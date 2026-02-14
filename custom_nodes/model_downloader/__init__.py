from .download_node import ModelDownloader, comfy_entrypoint
from . import registry_manager  # noqa – registers API routes on import

__all__ = ["ModelDownloader", "comfy_entrypoint"]

NODE_CLASS_MAPPINGS = {
    "ModelDownloader": ModelDownloader,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "ModelDownloader": "Zorg Model Downloader",
}

WEB_DIRECTORY = "./js"
