"""
Zorg Platform Uploader - ComfyUI Custom Node

Uploads generated images, videos, or audio from ComfyUI workflows
directly to the Zorg (QuantiMed Marketing Suite) platform.

Credentials (email, password, API URL) are configured in the ComfyUI
Settings panel under "Zorg Platform".

Authenticates via email/password → JWT, then uploads via the /upload API.
"""

from __future__ import annotations

import io as stdlib_io
import os
import json
import logging
import tempfile
import uuid
from typing import Optional

import numpy as np
import requests
import torch
from PIL import Image as PILImage
from typing_extensions import override

import folder_paths
from comfy_api.latest import ComfyExtension, io, ui

logger = logging.getLogger("ZorgUploader")


# ---------------------------------------------------------------------------
# Read Zorg credentials from ComfyUI settings (comfy.settings.json)
# ---------------------------------------------------------------------------
def _get_zorg_settings() -> dict:
    """Read Zorg.Email, Zorg.Password, Zorg.ApiUrl from the user settings file."""
    user_dir = folder_paths.get_user_directory()
    settings_file = os.path.join(user_dir, "default", "comfy.settings.json")

    settings = {}
    if os.path.isfile(settings_file):
        try:
            with open(settings_file, "r") as f:
                settings = json.load(f)
        except Exception as e:
            logger.warning(f"Could not read settings file: {e}")

    email = settings.get("Zorg.Email", "")
    password = settings.get("Zorg.Password", "")
    api_url = settings.get("Zorg.ApiUrl", "") or os.getenv("ZORG_API_URL", "https://api.zorgsocial.com")

    return {"email": email, "password": password, "api_url": api_url}


# ---------------------------------------------------------------------------
# Helper: authenticate and retrieve a JWT access token
# ---------------------------------------------------------------------------
def _zorg_login(api_url: str, email: str, password: str) -> str:
    """
    POST /users/login with {email, password}.
    Returns the access token string.
    """
    login_url = f"{api_url.rstrip('/')}/users/login"
    payload = {"email": email, "password": password}

    resp = requests.post(login_url, json=payload, timeout=30)
    if resp.status_code != 200:
        detail = resp.text[:300]
        raise RuntimeError(
            f"Zorg login failed (HTTP {resp.status_code}): {detail}"
        )

    data = resp.json()
    token = data.get("token")
    if not token:
        raise RuntimeError("Zorg login response did not contain a token.")
    return token


# ---------------------------------------------------------------------------
# Helper: upload a file to Zorg
# ---------------------------------------------------------------------------
def _zorg_upload(
    api_url: str,
    token: str,
    file_bytes: bytes,
    filename: str,
    content_type: str,
    upload_type: str,  # "image" | "video" | "audio"
) -> dict:
    """
    POST /upload/{upload_type} with a multipart file upload.
    Returns the JSON response dict.
    """
    upload_url = f"{api_url.rstrip('/')}/upload/{upload_type}"
    headers = {"Authorization": f"Bearer {token}"}
    files = {"file": (filename, file_bytes, content_type)}

    resp = requests.post(upload_url, headers=headers, files=files, timeout=120)
    if resp.status_code not in (200, 201):
        detail = resp.text[:300]
        raise RuntimeError(
            f"Zorg upload failed (HTTP {resp.status_code}): {detail}"
        )

    return resp.json()


# ---------------------------------------------------------------------------
# Helper: convert IMAGE tensor → PNG bytes
# ---------------------------------------------------------------------------
def _image_tensor_to_png_bytes(image_tensor: torch.Tensor) -> bytes:
    """Convert a single [H, W, C] float image tensor to PNG bytes."""
    arr = np.clip(255.0 * image_tensor.cpu().numpy(), 0, 255).astype(np.uint8)
    pil_img = PILImage.fromarray(arr)
    buf = stdlib_io.BytesIO()
    pil_img.save(buf, format="PNG")
    return buf.getvalue()


# ---------------------------------------------------------------------------
# Helper: convert AUDIO dict → WAV bytes
# ---------------------------------------------------------------------------
def _audio_to_wav_bytes(audio_dict: dict) -> bytes:
    """Convert ComfyUI audio dict {waveform, sample_rate} to WAV bytes."""
    import struct

    waveform = audio_dict["waveform"]  # [B, C, T]
    sample_rate = audio_dict["sample_rate"]

    # Take the first item in the batch
    if waveform.dim() == 3:
        waveform = waveform[0]  # [C, T]

    num_channels = waveform.shape[0]
    num_frames = waveform.shape[1]

    # Convert to 16-bit PCM
    pcm = (waveform.clamp(-1, 1) * 32767).to(torch.int16).cpu()

    # Interleave channels: [C, T] → [T, C] → flatten
    pcm_interleaved = pcm.permute(1, 0).contiguous().numpy().flatten()
    pcm_bytes = pcm_interleaved.tobytes()

    # Build WAV header
    bits_per_sample = 16
    byte_rate = sample_rate * num_channels * bits_per_sample // 8
    block_align = num_channels * bits_per_sample // 8
    data_size = len(pcm_bytes)
    file_size = 36 + data_size

    buf = stdlib_io.BytesIO()
    buf.write(b"RIFF")
    buf.write(struct.pack("<I", file_size))
    buf.write(b"WAVE")
    buf.write(b"fmt ")
    buf.write(struct.pack("<I", 16))  # chunk size
    buf.write(struct.pack("<H", 1))  # PCM
    buf.write(struct.pack("<H", num_channels))
    buf.write(struct.pack("<I", sample_rate))
    buf.write(struct.pack("<I", byte_rate))
    buf.write(struct.pack("<H", block_align))
    buf.write(struct.pack("<H", bits_per_sample))
    buf.write(b"data")
    buf.write(struct.pack("<I", data_size))
    buf.write(pcm_bytes)
    return buf.getvalue()


# ---------------------------------------------------------------------------
# Helper: save VIDEO to a temp file and read bytes
# ---------------------------------------------------------------------------
def _video_to_mp4_bytes(video) -> bytes:
    """Save a ComfyUI VideoInput to a temp MP4 file, then return the bytes."""
    tmp_path = os.path.join(tempfile.gettempdir(), f"zorg_upload_{uuid.uuid4().hex}.mp4")
    try:
        video.save_to(tmp_path)
        with open(tmp_path, "rb") as f:
            return f.read()
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)


# ===========================================================================================
# COMFYUI NODE: Upload Image to Zorg
# ===========================================================================================
class ZorgUploadImage(io.ComfyNode):
    """Upload generated images to the Zorg platform."""

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="ZorgUploadImage",
            display_name="Upload Image to Zorg",
            description="Uploads an image to the Zorg platform. "
                        "Configure credentials in Settings → Zorg Platform.",
            category="Zorg Platform",
            is_output_node=True,
            inputs=[
                io.Image.Input("image", tooltip="The image to upload to Zorg."),
                io.String.Input(
                    "filename_prefix",
                    multiline=False,
                    default="comfyui_output",
                    tooltip="Filename prefix. A UUID will be appended automatically.",
                ),
            ],
            outputs=[],
        )

    @classmethod
    def execute(cls, image, filename_prefix) -> io.NodeOutput:
        creds = _get_zorg_settings()
        if not creds["email"] or not creds["password"]:
            raise ValueError("Zorg credentials not configured. Go to Settings → Zorg Platform to set email and password.")

        logger.info("Authenticating with Zorg platform...")
        token = _zorg_login(creds["api_url"], creds["email"], creds["password"])
        logger.info("Authentication successful.")

        # image shape: [B, H, W, C] – upload each image in the batch
        results = []
        batch_size = image.shape[0]
        for i in range(batch_size):
            img_bytes = _image_tensor_to_png_bytes(image[i])
            name = f"{filename_prefix}_{uuid.uuid4().hex[:8]}.png"
            logger.info(f"Uploading image '{name}' ({len(img_bytes)} bytes)...")
            result = _zorg_upload(creds["api_url"], token, img_bytes, name, "image/png", "image")
            results.append(result)
            gcs_url = result.get("gcs_url", "N/A")
            logger.info(f"Image uploaded successfully: {gcs_url}")

        return io.NodeOutput(ui=ui.PreviewText(
            f"Uploaded {len(results)} image(s) to Zorg.\n"
            + "\n".join(f"  • {r.get('gcs_url', 'N/A')}" for r in results)
        ))


# ===========================================================================================
# COMFYUI NODE: Upload Video to Zorg
# ===========================================================================================
class ZorgUploadVideo(io.ComfyNode):
    """Upload generated video to the Zorg platform."""

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="ZorgUploadVideo",
            display_name="Upload Video to Zorg",
            description="Uploads a video to the Zorg platform. "
                        "Configure credentials in Settings → Zorg Platform.",
            category="Zorg Platform",
            is_output_node=True,
            inputs=[
                io.Video.Input("video", tooltip="The video to upload to Zorg."),
                io.String.Input(
                    "filename_prefix",
                    multiline=False,
                    default="comfyui_output",
                    tooltip="Filename prefix. A UUID will be appended automatically.",
                ),
            ],
            outputs=[],
        )

    @classmethod
    def execute(cls, video, filename_prefix) -> io.NodeOutput:
        creds = _get_zorg_settings()
        if not creds["email"] or not creds["password"]:
            raise ValueError("Zorg credentials not configured. Go to Settings → Zorg Platform to set email and password.")

        logger.info("Authenticating with Zorg platform...")
        token = _zorg_login(creds["api_url"], creds["email"], creds["password"])
        logger.info("Authentication successful.")

        filename = f"{filename_prefix}_{uuid.uuid4().hex[:8]}.mp4"
        logger.info("Converting video to MP4 bytes...")
        video_bytes = _video_to_mp4_bytes(video)
        logger.info(f"Uploading video '{filename}' ({len(video_bytes)} bytes)...")
        result = _zorg_upload(creds["api_url"], token, video_bytes, filename, "video/mp4", "video")
        gcs_url = result.get("gcs_url", "N/A")
        logger.info(f"Video uploaded successfully: {gcs_url}")

        return io.NodeOutput(ui=ui.PreviewText(
            f"Video uploaded to Zorg.\n  URL: {gcs_url}"
        ))


# ===========================================================================================
# COMFYUI NODE: Upload Audio to Zorg
# ===========================================================================================
class ZorgUploadAudio(io.ComfyNode):
    """Upload generated audio to the Zorg platform."""

    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="ZorgUploadAudio",
            display_name="Upload Audio to Zorg",
            description="Uploads audio to the Zorg platform. "
                        "Configure credentials in Settings → Zorg Platform.",
            category="Zorg Platform",
            is_output_node=True,
            inputs=[
                io.Audio.Input("audio", tooltip="The audio to upload to Zorg."),
                io.String.Input(
                    "filename_prefix",
                    multiline=False,
                    default="comfyui_output",
                    tooltip="Filename prefix. A UUID will be appended automatically.",
                ),
            ],
            outputs=[],
        )

    @classmethod
    def execute(cls, audio, filename_prefix) -> io.NodeOutput:
        creds = _get_zorg_settings()
        if not creds["email"] or not creds["password"]:
            raise ValueError("Zorg credentials not configured. Go to Settings → Zorg Platform to set email and password.")

        logger.info("Authenticating with Zorg platform...")
        token = _zorg_login(creds["api_url"], creds["email"], creds["password"])
        logger.info("Authentication successful.")

        filename = f"{filename_prefix}_{uuid.uuid4().hex[:8]}.wav"
        logger.info("Converting audio to WAV bytes...")
        audio_bytes = _audio_to_wav_bytes(audio)
        logger.info(f"Uploading audio '{filename}' ({len(audio_bytes)} bytes)...")
        result = _zorg_upload(creds["api_url"], token, audio_bytes, filename, "audio/wav", "audio")
        gcs_url = result.get("gcs_url", "N/A")
        logger.info(f"Audio uploaded successfully: {gcs_url}")

        return io.NodeOutput(ui=ui.PreviewText(
            f"Audio uploaded to Zorg.\n  URL: {gcs_url}"
        ))


# ===========================================================================================
# Extension Registration
# ===========================================================================================
class ZorgUploaderExtension(ComfyExtension):
    @override
    async def get_node_list(self) -> list[type[io.ComfyNode]]:
        return [
            ZorgUploadImage,
            ZorgUploadVideo,
            ZorgUploadAudio,
        ]


async def comfy_entrypoint() -> ZorgUploaderExtension:
    """ComfyUI calls this to load the extension and its nodes."""
    return ZorgUploaderExtension()
