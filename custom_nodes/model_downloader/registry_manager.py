"""
Registry manager for model downloads.

Registers API endpoints on the ComfyUI server that the
Missing-Models JS dialog calls:

  GET  /model_downloader/registry          – return saved URL registry
  POST /model_downloader/registry/add      – persist a model→URL mapping
  GET  /model_downloader/model_input_map   – {class_type: {input: folder}}
  POST /model_downloader/download          – start a background download
  GET  /model_downloader/progress          – poll download progress
  POST /model_downloader/search_hf         – search HuggingFace for a model file
"""

import json
import logging
import os
import re
import threading
import urllib.parse
import urllib.request

import folder_paths
import nodes
from aiohttp import web
from server import PromptServer

# ── Registry file ────────────────────────────────────────────────────
REGISTRY_PATH = os.path.join(os.path.dirname(__file__), "model_registry.json")


def _load_registry() -> dict:
    try:
        with open(REGISTRY_PATH, "r") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {"models": {}}


def _save_registry(data: dict) -> None:
    with open(REGISTRY_PATH, "w") as f:
        json.dump(data, f, indent=2)


# ── Download tracking ───────────────────────────────────────────────
_active_downloads: dict[str, dict] = {}
_download_lock = threading.Lock()


# ── Model-input → folder mapping ────────────────────────────────────
def _build_model_input_map() -> dict[str, dict[str, str]]:
    """
    Inspect every registered node's INPUT_TYPES() and match combo-list
    inputs against folder_paths file-lists to produce:
        { "CheckpointLoaderSimple": { "ckpt_name": "checkpoints" }, … }
    """
    mapping: dict[str, dict[str, str]] = {}

    # Cache all folder → set(filenames)
    folder_file_sets: dict[str, set[str]] = {}
    for folder_name in list(folder_paths.folder_names_and_paths.keys()):
        try:
            fl = folder_paths.get_filename_list(folder_name)
            if fl:
                folder_file_sets[folder_name] = set(fl)
        except Exception:
            pass

    for class_type, cls in nodes.NODE_CLASS_MAPPINGS.items():
        # Get the input spec — works for both V1 and V3 nodes
        try:
            input_types = cls.INPUT_TYPES()
        except Exception:
            # V3 nodes don't have INPUT_TYPES(); use GET_NODE_INFO_V1()
            try:
                info = cls.GET_NODE_INFO_V1()
                input_types = info.get("input", {})
            except Exception:
                continue

        for category in ("required", "optional"):
            inputs = input_types.get(category, {})
            if not isinstance(inputs, dict):
                continue
            for input_name, input_config in inputs.items():
                if not isinstance(input_config, (tuple, list)) or len(input_config) == 0:
                    continue
                type_info = input_config[0]
                if not isinstance(type_info, list) or len(type_info) == 0:
                    continue
                # This is a combo input – does its option set match a folder?
                input_set = set(type_info)
                for folder_name, folder_files in folder_file_sets.items():
                    if input_set == folder_files:
                        mapping.setdefault(class_type, {})[input_name] = folder_name
                        break

    return mapping


# ── Helpers ──────────────────────────────────────────────────────────
def _filename_from_url(url: str) -> str:
    path = urllib.parse.urlparse(url).path
    name = os.path.basename(path).split("?")[0]
    return urllib.parse.unquote(name) if name else "downloaded_model"


def _filename_from_content_disposition(header: str) -> str | None:
    if not header:
        return None
    m = re.search(r"filename\*\s*=\s*(?:UTF-8''|utf-8'')(.+)", header, re.IGNORECASE)
    if m:
        return urllib.parse.unquote(m.group(1).strip().strip('"'))
    m = re.search(r'filename\s*=\s*"?([^";]+)"?', header, re.IGNORECASE)
    if m:
        return m.group(1).strip().strip('"')
    return None


def _invalidate_folder_cache(folder_name: str) -> None:
    """Remove cached file-list so ComfyUI rescans the folder."""
    try:
        if folder_name in folder_paths.filename_list_cache:
            del folder_paths.filename_list_cache[folder_name]
    except Exception:
        pass


# ── Background download worker ──────────────────────────────────────
def _download_worker(
    download_id: str,
    url: str,
    target_dir: str,
    filename: str,
    folder_name: str,
    token: str,
) -> None:
    try:
        headers = {"User-Agent": "Mozilla/5.0 (ComfyUI ModelDownloader)"}
        if token:
            headers["Authorization"] = f"Bearer {token}"

        req = urllib.request.Request(url, headers=headers)
        dest = os.path.join(target_dir, filename)
        logging.info("[ModelDownloader] Downloading %s → %s", url, dest)

        with urllib.request.urlopen(req) as resp:
            # Refine filename from Content-Disposition if needed
            cd = resp.headers.get("Content-Disposition", "")
            header_name = _filename_from_content_disposition(cd)
            if header_name and filename in ("", "downloaded_model"):
                filename = header_name
                dest = os.path.join(target_dir, filename)
                with _download_lock:
                    _active_downloads[download_id]["filename"] = filename

            total = resp.headers.get("Content-Length")
            total = int(total) if total else 0
            with _download_lock:
                _active_downloads[download_id]["total"] = total

            downloaded = 0
            chunk_size = 1024 * 1024  # 1 MB
            with open(dest, "wb") as f:
                while True:
                    chunk = resp.read(chunk_size)
                    if not chunk:
                        break
                    f.write(chunk)
                    downloaded += len(chunk)
                    with _download_lock:
                        _active_downloads[download_id]["progress"] = downloaded

        _invalidate_folder_cache(folder_name)

        with _download_lock:
            _active_downloads[download_id]["status"] = "completed"
        logging.info("[ModelDownloader] Completed: %s", dest)

    except Exception as e:
        logging.error("[ModelDownloader] Error: %s", e)
        with _download_lock:
            _active_downloads[download_id]["status"] = "error"
            _active_downloads[download_id]["error"] = str(e)


# ── API Routes ───────────────────────────────────────────────────────

@PromptServer.instance.routes.get("/model_downloader/registry")
async def get_registry(request):
    return web.json_response(_load_registry())


@PromptServer.instance.routes.post("/model_downloader/registry/add")
async def add_to_registry(request):
    data = await request.json()
    model_name = data.get("model_name", "").strip()
    url = data.get("url", "").strip()
    folder = data.get("folder", "").strip()
    description = data.get("description", "").strip()

    if not model_name or not url:
        return web.json_response({"error": "model_name and url required"}, status=400)

    registry = _load_registry()
    registry["models"][model_name] = {
        "url": url,
        "folder": folder,
        "description": description,
    }
    _save_registry(registry)
    return web.json_response({"status": "ok"})


@PromptServer.instance.routes.get("/model_downloader/model_input_map")
async def get_model_input_map(request):
    return web.json_response(_build_model_input_map())


@PromptServer.instance.routes.post("/model_downloader/download")
async def start_download(request):
    data = await request.json()
    url = data.get("url", "").strip()
    folder = data.get("folder", "").strip()
    filename = data.get("filename", "").strip()
    token = data.get("token", "").strip()

    if not url:
        return web.json_response({"error": "url is required"}, status=400)
    if not folder:
        return web.json_response({"error": "folder is required"}, status=400)

    # Resolve target directory
    if folder in folder_paths.folder_names_and_paths:
        target_dir = folder_paths.folder_names_and_paths[folder][0][0]
    else:
        comfy_root = os.path.dirname(folder_paths.__file__)
        target_dir = os.path.join(comfy_root, "models", folder)
    os.makedirs(target_dir, exist_ok=True)

    if not filename:
        filename = _filename_from_url(url)

    download_id = f"{folder}/{filename}"

    with _download_lock:
        existing = _active_downloads.get(download_id, {})
        if existing.get("status") == "downloading":
            return web.json_response(
                {"error": "Already downloading", "download_id": download_id},
                status=409,
            )
        _active_downloads[download_id] = {
            "status": "downloading",
            "progress": 0,
            "total": 0,
            "filename": filename,
            "folder": folder,
        }

    thread = threading.Thread(
        target=_download_worker,
        args=(download_id, url, target_dir, filename, folder, token),
        daemon=True,
    )
    thread.start()

    return web.json_response({"status": "started", "download_id": download_id})


@PromptServer.instance.routes.get("/model_downloader/progress")
async def get_progress(request):
    download_id = request.query.get("download_id", "")
    if download_id and download_id in _active_downloads:
        return web.json_response(_active_downloads[download_id])
    return web.json_response(_active_downloads)


@PromptServer.instance.routes.post("/model_downloader/search_hf")
async def search_huggingface(request):
    """Search HuggingFace for a model file by name."""
    data = await request.json()
    query = data.get("query", "").strip()
    if not query:
        return web.json_response({"results": []})

    # Strip common extensions for search
    search_name = re.sub(r"\.(safetensors|ckpt|pt|bin|pth|gguf)$", "", query, flags=re.IGNORECASE)

    results = []
    try:
        # Search HuggingFace API for models matching the name
        search_url = f"https://huggingface.co/api/models?search={urllib.parse.quote(search_name)}&limit=10&sort=downloads&direction=-1"
        headers = {"User-Agent": "Mozilla/5.0 (ComfyUI ModelDownloader)"}
        req = urllib.request.Request(search_url, headers=headers)

        with urllib.request.urlopen(req, timeout=10) as resp:
            models = json.loads(resp.read().decode())

        # For each matching repo, look for files matching the query
        for model in models[:5]:
            repo_id = model.get("id", "")
            if not repo_id:
                continue

            # Try to list files in the repo
            try:
                files_url = f"https://huggingface.co/api/models/{repo_id}?blobs=true"
                req = urllib.request.Request(files_url, headers=headers)
                with urllib.request.urlopen(req, timeout=8) as resp:
                    repo_info = json.loads(resp.read().decode())

                siblings = repo_info.get("siblings", [])
                for sibling in siblings:
                    fname = sibling.get("rfilename", "")
                    # Match if filename contains search term or exactly matches
                    if (
                        fname.lower() == query.lower()
                        or search_name.lower() in fname.lower()
                    ) and any(
                        fname.endswith(ext)
                        for ext in (".safetensors", ".ckpt", ".pt", ".bin", ".pth", ".gguf")
                    ):
                        dl_url = f"https://huggingface.co/{repo_id}/resolve/main/{urllib.parse.quote(fname)}"
                        results.append({
                            "repo": repo_id,
                            "filename": fname,
                            "url": dl_url,
                        })
                        if len(results) >= 8:
                            break
            except Exception:
                continue

            if len(results) >= 8:
                break

    except Exception as e:
        logging.warning("[ModelDownloader] HuggingFace search error: %s", e)

    return web.json_response({"results": results})
