#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# Zorg DeepCore — Download ALL models in one shot
# Run from inside the Vast.ai pod: bash /workspace/ComfyUI/scripts/download_all_models.sh
# Uses wget -nc (no-clobber) so it's safe to re-run — skips already downloaded files.
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

MODELS="/workspace/ComfyUI/models"

echo "=============================================="
echo "  Zorg DeepCore — Downloading ALL models"
echo "=============================================="
echo ""

# ── Create all directories ───────────────────────────────────────────────
mkdir -p "$MODELS"/{checkpoints,text_encoders,vae,diffusion_models,latent_upscale_models,loras,clip_vision,wav2vec2}

cd "$MODELS"

# ── Helper ───────────────────────────────────────────────────────────────
dl() {
  local dir="$1" url="$2" file
  file=$(basename "$url")
  if [[ -f "$dir/$file" ]]; then
    echo "  [SKIP] $dir/$file (already exists)"
  else
    echo "  [GET]  $dir/$file"
    wget -q --show-progress -nc -P "$dir" "$url"
  fi
}

dl_rename() {
  local dir="$1" url="$2" filename="$3"
  if [[ -f "$dir/$filename" ]]; then
    echo "  [SKIP] $dir/$filename (already exists)"
  else
    echo "  [GET]  $dir/$filename"
    wget -q --show-progress -nc -O "$dir/$filename" "$url"
  fi
}

# ══════════════════════════════════════════════════════════════════════════
echo ""
echo "━━━ [1/5] Z-Image Turbo (~8 GB) ━━━"
# ══════════════════════════════════════════════════════════════════════════
dl text_encoders  "https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/split_files/text_encoders/qwen_3_4b.safetensors"
dl vae            "https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/split_files/vae/ae.safetensors"
dl diffusion_models "https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/split_files/diffusion_models/z_image_turbo_bf16.safetensors"
echo "  ✓ Z-Image Turbo done"

# ══════════════════════════════════════════════════════════════════════════
echo ""
echo "━━━ [2/5] LTX-2 (~25 GB) ━━━"
# ══════════════════════════════════════════════════════════════════════════
dl checkpoints           "https://huggingface.co/Lightricks/LTX-2/resolve/main/ltx-2-19b-dev-fp8.safetensors"
dl text_encoders         "https://huggingface.co/Comfy-Org/ltx-2/resolve/main/split_files/text_encoders/gemma_3_12B_it_fp4_mixed.safetensors"
dl latent_upscale_models "https://huggingface.co/Lightricks/LTX-2/resolve/main/ltx-2-spatial-upscaler-x2-1.0.safetensors"
dl loras                 "https://huggingface.co/Lightricks/LTX-2/resolve/main/ltx-2-19b-distilled-lora-384.safetensors"
dl loras                 "https://huggingface.co/Lightricks/LTX-2-19b-LoRA-Camera-Control-Dolly-Left/resolve/main/ltx-2-19b-lora-camera-control-dolly-left.safetensors"
echo "  ✓ LTX-2 done"

# ══════════════════════════════════════════════════════════════════════════
echo ""
echo "━━━ [3/5] LTX-2.3 (~30 GB) ━━━"
# ══════════════════════════════════════════════════════════════════════════
dl checkpoints           "https://huggingface.co/Lightricks/LTX-2.3/resolve/main/ltx-2.3-22b-dev.safetensors"
dl latent_upscale_models "https://huggingface.co/Lightricks/LTX-2.3/resolve/main/ltx-2.3-spatial-upscaler-x2-1.1.safetensors"
dl loras                 "https://huggingface.co/Lightricks/LTX-2.3/resolve/main/ltx-2.3-22b-distilled-lora-384.safetensors"
# text encoder (gemma_3_12B) already downloaded in LTX-2 — will be skipped
dl text_encoders         "https://huggingface.co/Comfy-Org/ltx-2/resolve/main/split_files/text_encoders/gemma_3_12B_it_fp4_mixed.safetensors"
dl loras                 "https://huggingface.co/Comfy-Org/ltx-2/resolve/main/split_files/loras/gemma-3-12b-it-abliterated_lora_rank64_bf16.safetensors"
echo "  ✓ LTX-2.3 done"

# ══════════════════════════════════════════════════════════════════════════
echo ""
echo "━━━ [4/5] Wan 2.2 (~30 GB) ━━━"
# ══════════════════════════════════════════════════════════════════════════
dl text_encoders     "https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/text_encoders/umt5_xxl_fp8_e4m3fn_scaled.safetensors"
dl vae               "https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/vae/wan_2.1_vae.safetensors"
dl diffusion_models  "https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/diffusion_models/wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors"
dl diffusion_models  "https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/diffusion_models/wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors"
dl loras             "https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/loras/wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors"
dl loras             "https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/loras/wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors"
echo "  ✓ Wan 2.2 done"

# ══════════════════════════════════════════════════════════════════════════
echo ""
echo "━━━ [5/5] InfiniteTalk (~45 GB) ━━━"
# ══════════════════════════════════════════════════════════════════════════
dl diffusion_models  "https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/diffusion_models/wan2.1_i2v_720p_14B_fp16.safetensors"
dl loras             "https://huggingface.co/Kijai/WanVideo_comfy/resolve/main/Lightx2v/lightx2v_I2V_14B_480p_cfg_step_distill_rank64_bf16.safetensors"
dl diffusion_models  "https://huggingface.co/MeiGen-AI/InfiniteTalk/resolve/main/single/infinitetalk.safetensors"
dl_rename diffusion_models "https://huggingface.co/MeiGen-AI/InfiniteTalk/resolve/main/multi/infinitetalk.safetensors" "infinitetalk-multi.safetensors"
dl vae               "https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/vae/wan_2.1_vae.safetensors"
dl clip_vision       "https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/clip_vision/clip_vision_h.safetensors"
dl wav2vec2          "https://huggingface.co/Kijai/wav2vec2_safetensors/resolve/main/wav2vec2-chinese-base_fp16.safetensors"
dl text_encoders     "https://huggingface.co/ALGOTECH/WanVideo_comfy/resolve/main/umt5-xxl-enc-bf16.safetensors"
echo "  ✓ InfiniteTalk done"

# ══════════════════════════════════════════════════════════════════════════
echo ""
echo "=============================================="
echo "  ALL MODELS DOWNLOADED SUCCESSFULLY"
echo "=============================================="
echo ""
echo "Disk usage:"
du -sh "$MODELS"/*/ 2>/dev/null | sort -rh
echo "─────────"
du -sh "$MODELS"
