import os

from .zorg_upload_node import (
    ZorgUploaderExtension,
    ZorgUploadImage,
    ZorgUploadVideo,
    ZorgUploadAudio,
    comfy_entrypoint,
)

# V3 entry point (ComfyExtension)
__all__ = ["ZorgUploaderExtension", "comfy_entrypoint"]

# Frontend JS extension (password masking)
WEB_DIRECTORY = os.path.join(os.path.dirname(os.path.realpath(__file__)), "js")

# V1 fallback – ensures the nodes are discovered even if V3 loading is not used
NODE_CLASS_MAPPINGS = {
    "ZorgUploadImage": ZorgUploadImage,
    "ZorgUploadVideo": ZorgUploadVideo,
    "ZorgUploadAudio": ZorgUploadAudio,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "ZorgUploadImage": "Upload Image to Zorg",
    "ZorgUploadVideo": "Upload Video to Zorg",
    "ZorgUploadAudio": "Upload Audio to Zorg",
}
