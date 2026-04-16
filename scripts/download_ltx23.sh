#!/bin/bash
set -euo pipefail

MODELS="/workspace/ComfyUI/models"
mkdir -p "$MODELS"/{checkpoints,text_encoders,latent_upscale_models,loras}
cd "$MODELS"

echo "━━━ Downloading LTX-2.3 models ━━━"

echo "[1/5] checkpoints/ltx-2.3-22b-dev.safetensors"
wget -nc -P checkpoints \
  'https://huggingface.co/Lightricks/LTX-2.3/resolve/main/ltx-2.3-22b-dev.safetensors'

echo "[2/5] latent_upscale_models/ltx-2.3-spatial-upscaler-x2-1.1.safetensors"
wget -nc -P latent_upscale_models \
  'https://huggingface.co/Lightricks/LTX-2.3/resolve/main/ltx-2.3-spatial-upscaler-x2-1.1.safetensors'

echo "[3/5] loras/ltx-2.3-22b-distilled-lora-384.safetensors"
wget -nc -P loras \
  'https://huggingface.co/Lightricks/LTX-2.3/resolve/main/ltx-2.3-22b-distilled-lora-384.safetensors'

echo "[4/5] text_encoders/gemma_3_12B_it_fp4_mixed.safetensors"
wget -nc -P text_encoders \
  'https://huggingface.co/Comfy-Org/ltx-2/resolve/main/split_files/text_encoders/gemma_3_12B_it_fp4_mixed.safetensors'

echo "[5/5] loras/gemma-3-12b-it-abliterated_lora_rank64_bf16.safetensors"
wget -nc -P loras \
  'https://huggingface.co/Comfy-Org/ltx-2/resolve/main/split_files/loras/gemma-3-12b-it-abliterated_lora_rank64_bf16.safetensors'

echo "✓ LTX-2.3 done"
