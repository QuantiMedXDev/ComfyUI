"""
ComfyUI custom node – Download Model from URL
Downloads any file from a URL into a directory relative to the ComfyUI root.
"""

import os
import re
import urllib.parse
import urllib.request
import folder_paths
from comfy_api.latest import io, ComfyExtension


class ModelDownloader(io.ComfyNode):
    """Downloads a file from a URL to a directory relative to ComfyUI root."""

    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="ModelDownloader",
            display_name="Zorg Model Downloader",
            category="utils",
            description="Downloads a model file from any URL to a specified directory relative to the ComfyUI root.",
            is_output_node=True,
            inputs=[
                io.String.Input(
                    "url",
                    display_name="URL",
                    tooltip="Direct download URL for the model file.",
                ),
                io.String.Input(
                    "directory",
                    display_name="Directory",
                    default="models/diffusion_models",
                    tooltip="Target directory relative to ComfyUI root (e.g. models/checkpoints).",
                ),
                io.String.Input(
                    "filename",
                    display_name="Filename (optional)",
                    default="",
                    tooltip="Custom filename. Leave empty to auto-detect from URL / headers.",
                ),
                io.String.Input(
                    "token",
                    display_name="Auth Token (optional)",
                    default="",
                    tooltip="Bearer token for gated models (e.g. HuggingFace token). Leave empty for public URLs.",
                ),
            ],
            outputs=[
                io.String.Output("file_path", display_name="Saved File Path"),
            ],
        )

    @classmethod
    def execute(cls, url: str, directory: str, filename: str, token: str):
        url = url.strip()
        directory = directory.strip().strip("/")
        filename = filename.strip()
        token = token.strip()

        if not url:
            raise ValueError("URL is required.")

        # Resolve absolute target directory
        comfy_root = os.path.dirname(folder_paths.__file__)
        abs_dir = os.path.join(comfy_root, directory)
        os.makedirs(abs_dir, exist_ok=True)

        # Build request with a browser-like user-agent so hosts don't reject it
        headers = {"User-Agent": "Mozilla/5.0 (ComfyUI ModelDownloader)"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        req = urllib.request.Request(url, headers=headers)

        # Determine filename
        if not filename:
            filename = _filename_from_url(url)

        # Stream download
        dest = os.path.join(abs_dir, filename)
        print(f"[ModelDownloader] Downloading {url}")
        print(f"[ModelDownloader] Saving to   {dest}")

        with urllib.request.urlopen(req) as resp:
            # Try to refine filename from Content-Disposition header
            if not filename or filename == "downloaded_model":
                cd = resp.headers.get("Content-Disposition", "")
                header_name = _filename_from_content_disposition(cd)
                if header_name:
                    filename = header_name
                    dest = os.path.join(abs_dir, filename)

            total = resp.headers.get("Content-Length")
            total = int(total) if total else None
            downloaded = 0
            chunk_size = 1024 * 1024  # 1 MB

            with open(dest, "wb") as f:
                while True:
                    chunk = resp.read(chunk_size)
                    if not chunk:
                        break
                    f.write(chunk)
                    downloaded += len(chunk)
                    if total:
                        pct = downloaded * 100 // total
                        print(
                            f"\r[ModelDownloader] {downloaded}/{total} bytes ({pct}%)",
                            end="",
                            flush=True,
                        )

        print(f"\n[ModelDownloader] Done – {dest}")
        return io.NodeOutput(dest)


def _filename_from_url(url: str) -> str:
    """Extract a filename from the URL path, falling back to a generic name."""
    path = urllib.parse.urlparse(url).path
    name = os.path.basename(path)
    # strip query leftovers
    name = name.split("?")[0]
    if not name or name == "":
        name = "downloaded_model"
    return urllib.parse.unquote(name)


def _filename_from_content_disposition(header: str) -> str | None:
    """Parse filename from a Content-Disposition header."""
    if not header:
        return None
    # Try filename*= (RFC 5987)
    match = re.search(r"filename\*\s*=\s*(?:UTF-8''|utf-8'')(.+)", header, re.IGNORECASE)
    if match:
        return urllib.parse.unquote(match.group(1).strip().strip('"'))
    # Try filename=
    match = re.search(r'filename\s*=\s*"?([^";]+)"?', header, re.IGNORECASE)
    if match:
        return match.group(1).strip().strip('"')
    return None


# ── V3 extension wrapper ────────────────────────────────────────────
class ModelDownloaderExtension(ComfyExtension):
    async def get_node_list(self):
        return [ModelDownloader]


async def comfy_entrypoint():
    return ModelDownloaderExtension()
