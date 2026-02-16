import { app } from "../../scripts/app.js";

// ── State ──────────────────────────────────────────────────────────
let modelInputMap = null;
let registry = null;
let dialogEl = null;

const MEDIA_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff", ".svg",
  ".mp4", ".mov", ".avi", ".mkv", ".webm", ".m4v", ".mpg", ".mpeg",
  ".wav", ".mp3", ".flac", ".ogg", ".m4a", ".aac", ".opus", ".wma",
]);

// Well-known input_name → folder_paths folder name.
// Covers all standard ComfyUI loader nodes + common custom nodes.
const INPUT_NAME_TO_FOLDER = {
  ckpt_name:          "checkpoints",
  unet_name:          "diffusion_models",
  clip_name:          "text_encoders",
  vae_name:           "vae",
  lora_name:          "loras",
  control_net_name:   "controlnet",
  clip_vision:        "clip_vision",
  style_model_name:   "style_models",
  embedding_name:     "embeddings",
  hypernetwork_name:  "hypernetworks",
  upscale_model_name: "upscale_models",
  photomaker_name:    "photomaker",
  gligen_name:        "gligen",
  model_name:         "diffusion_models",
};

const HF_TOKEN_SETTING_ID = "Zorg.ModelDownloader.HuggingFaceToken";

// ── Extension Registration ─────────────────────────────────────────
app.registerExtension({
  name: "Zorg.ModelChecker",
  async setup() {
    createFloatingButton();
    maskHfTokenInSettings();
  },
  settings: [
    {
      id: HF_TOKEN_SETTING_ID,
      name: "HuggingFace Token",
      category: ["Zorg Model Downloader", "Authentication"],
      type: "string",
      defaultValue: "",
      tooltip: "Your HuggingFace access token for downloading gated models. Get one at https://huggingface.co/settings/tokens",
    },
  ],
});

function getHfToken() {
  try {
    return app.ui?.settings?.getSettingValue(HF_TOKEN_SETTING_ID) || "";
  } catch (_) {
    return "";
  }
}

// Mask the HF token field in Settings panel so it's not visible on screen
function maskHfTokenInSettings() {
  const observer = new MutationObserver(() => {
    const inputs = document.querySelectorAll("input[type='text']");
    for (const inp of inputs) {
      const label = inp.closest?.("div")?.querySelector?.("label, span, div");
      const nearText = inp.parentElement?.textContent || "";
      if (
        nearText.includes("HuggingFace Token") &&
        inp.type !== "password"
      ) {
        inp.type = "password";
        inp.autocomplete = "off";
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

// ── Floating Draggable Button ───────────────────────────────────────
function createFloatingButton() {
  const btn = document.createElement("button");
  btn.id = "zorg-missing-models-btn";
  btn.innerHTML = "📦 Missing Models";
  Object.assign(btn.style, {
    position: "fixed",
    bottom: "20px",
    right: "20px",
    zIndex: "9999",
    background: "#1e1e2e",
    color: "#cdd6f4",
    border: "1px solid #585b70",
    borderRadius: "8px",
    padding: "8px 16px",
    fontSize: "14px",
    fontWeight: "600",
    cursor: "grab",
    boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
    transition: "background 0.2s, border-color 0.2s, box-shadow 0.2s",
    userSelect: "none",
  });
  btn.onmouseenter = () => {
    btn.style.background = "#313244";
    btn.style.borderColor = "#89b4fa";
  };
  btn.onmouseleave = () => {
    btn.style.background = "#1e1e2e";
    btn.style.borderColor = "#585b70";
  };

  // Restore saved position
  try {
    const saved = JSON.parse(localStorage.getItem("zorg_btn_pos"));
    if (saved) {
      btn.style.left = saved.left + "px";
      btn.style.top = saved.top + "px";
      btn.style.right = "auto";
      btn.style.bottom = "auto";
    }
  } catch (_) {}

  // Drag logic
  let isDragging = false;
  let wasDragged = false;
  let startX, startY, origLeft, origTop;

  btn.addEventListener("mousedown", (e) => {
    isDragging = true;
    wasDragged = false;
    btn.style.cursor = "grabbing";
    btn.style.transition = "none";
    const rect = btn.getBoundingClientRect();
    origLeft = rect.left;
    origTop = rect.top;
    startX = e.clientX;
    startY = e.clientY;
    e.preventDefault();
  });

  document.addEventListener("mousemove", (e) => {
    if (!isDragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) wasDragged = true;
    btn.style.left = (origLeft + dx) + "px";
    btn.style.top = (origTop + dy) + "px";
    btn.style.right = "auto";
    btn.style.bottom = "auto";
  });

  document.addEventListener("mouseup", () => {
    if (!isDragging) return;
    isDragging = false;
    btn.style.cursor = "grab";
    btn.style.transition = "background 0.2s, border-color 0.2s, box-shadow 0.2s";
    // Save position
    try {
      const rect = btn.getBoundingClientRect();
      localStorage.setItem("zorg_btn_pos", JSON.stringify({ left: rect.left, top: rect.top }));
    } catch (_) {}
  });

  btn.onclick = (e) => {
    if (wasDragged) { e.preventDefault(); return; }
    openMissingModelsDialog();
  };

  document.body.appendChild(btn);
}

// ── Check Missing Models ───────────────────────────────────────────
async function openMissingModelsDialog() {
  try {
    const [mapResp, regResp] = await Promise.all([
      fetch("/model_downloader/model_input_map"),
      fetch("/model_downloader/registry"),
    ]);
    modelInputMap = await mapResp.json();
    registry = await regResp.json();
  } catch (e) {
    alert("Could not reach model_downloader server endpoints.\n" + e.message);
    return;
  }

  const missing = scanGraphForMissingModels();
  showDialog(missing);
}

function scanGraphForMissingModels() {
  const missing = [];
  const seen = new Set(); // dedup by model name only
  const ignoredModels = getIgnoredModels();

  // 1) Build a lookup from node.properties.models (workflow-embedded metadata).
  //    Each entry: { name, directory, url, hash? }
  const modelMeta = {}; // { modelName: { directory, url } }
  for (const node of app.graph._nodes || []) {
    if (node.properties?.models?.length) {
      for (const m of node.properties.models) {
        if (m.name && !modelMeta[m.name]) {
          modelMeta[m.name] = { directory: m.directory || "", url: m.url || "" };
        }
      }
    }
  }

  // 2) Also check top-level workflow models array (app.graph.extra?.models)
  const wfModels = app.graph.extra?.models || [];
  for (const m of wfModels) {
    if (m.name && !modelMeta[m.name]) {
      modelMeta[m.name] = { directory: m.directory || "", url: m.url || "" };
    }
  }

  // 3) Scan combo widgets for values not in available options (= missing).
  for (const node of app.graph._nodes || []) {
    const classType = node.comfyClass || node.type;
    for (const widget of node.widgets || []) {
      if (widget.type === "combo" && widget.options?.values) {
        const val = widget.value;
        if (val && !widget.options.values.includes(val)) {
          if (shouldSkipMissingValue(val) || ignoredModels.has(val)) continue;

          // Dedup by model name – same model file only needs one download
          if (seen.has(val)) continue;
          seen.add(val);

          // Resolve folder: embedded metadata > well-known input name > server map > registry > unknown
          const meta = modelMeta[val];
          const folder =
            meta?.directory ||
            INPUT_NAME_TO_FOLDER[widget.name] ||
            modelInputMap?.[classType]?.[widget.name] ||
            registry?.models?.[val]?.folder ||
            "unknown";

          // Resolve URL: embedded metadata > registry > empty
          const regEntry = registry?.models?.[val];
          const url = meta?.url || regEntry?.url || "";

          missing.push({
            nodeId: node.id,
            nodeTitle: node.title || classType,
            nodeType: classType,
            inputName: widget.name,
            modelName: val,
            folder,
            url,
            description: regEntry?.description || "",
          });
        }
      }
    }
  }
  return missing;
}

// ── Dialog UI ──────────────────────────────────────────────────────
function showDialog(missingModels) {
  if (dialogEl) {
    dialogEl.remove();
    dialogEl = null;
  }

  // Overlay
  const overlay = document.createElement("div");
  overlay.id = "zorg-model-checker-overlay";
  Object.assign(overlay.style, {
    position: "fixed",
    top: "0",
    left: "0",
    width: "100vw",
    height: "100vh",
    background: "rgba(0,0,0,0.6)",
    zIndex: "10000",
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
  });
  overlay.onclick = (e) => {
    if (e.target === overlay) {
      overlay.remove();
      dialogEl = null;
    }
  };

  // Modal
  const modal = document.createElement("div");
  Object.assign(modal.style, {
    background: "#1e1e2e",
    color: "#cdd6f4",
    borderRadius: "12px",
    padding: "24px",
    maxWidth: "720px",
    width: "90%",
    maxHeight: "80vh",
    overflow: "auto",
    boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  });

  // Header
  const header = document.createElement("div");
  Object.assign(header.style, {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: "16px",
    borderBottom: "1px solid #45475a",
    paddingBottom: "12px",
  });

  const title = document.createElement("h2");
  title.textContent = "📦 Missing Models";
  Object.assign(title.style, { margin: "0", fontSize: "20px", color: "#cdd6f4" });

  const closeBtn = document.createElement("button");
  closeBtn.textContent = "✕";
  Object.assign(closeBtn.style, {
    background: "none",
    border: "none",
    color: "#6c7086",
    fontSize: "20px",
    cursor: "pointer",
    padding: "4px 8px",
    borderRadius: "4px",
  });
  closeBtn.onmouseenter = () => (closeBtn.style.color = "#f38ba8");
  closeBtn.onmouseleave = () => (closeBtn.style.color = "#6c7086");
  closeBtn.onclick = () => {
    overlay.remove();
    dialogEl = null;
  };

  header.appendChild(title);
  header.appendChild(closeBtn);
  modal.appendChild(header);

  if (missingModels.length === 0) {
    const msg = document.createElement("div");
    Object.assign(msg.style, {
      textAlign: "center",
      padding: "40px 20px",
      color: "#a6e3a1",
      fontSize: "16px",
    });
    msg.innerHTML =
      '✅ <strong>All models are available!</strong><br>' +
      '<span style="color:#6c7086;font-size:13px;">No missing models detected in the current workflow.</span>';
    modal.appendChild(msg);
  } else {
    const count = document.createElement("div");
    count.textContent = `${missingModels.length} missing model${missingModels.length > 1 ? "s" : ""} found`;
    Object.assign(count.style, { color: "#f9e2af", fontSize: "13px", marginBottom: "12px" });
    modal.appendChild(count);

    const actions = document.createElement("div");
    Object.assign(actions.style, { display: "flex", justifyContent: "flex-end", marginBottom: "12px" });

    const addCustomBtn = document.createElement("button");
    addCustomBtn.textContent = "➕ Add Custom Download";
    Object.assign(addCustomBtn.style, {
      background: "#45475a",
      color: "#cdd6f4",
      border: "1px solid #585b70",
      borderRadius: "6px",
      padding: "7px 12px",
      fontSize: "12px",
      fontWeight: "600",
      cursor: "pointer",
      transition: "all 0.2s",
    });
    addCustomBtn.onmouseenter = () => { addCustomBtn.style.background = "#585b70"; addCustomBtn.style.borderColor = "#89b4fa"; };
    addCustomBtn.onmouseleave = () => { addCustomBtn.style.background = "#45475a"; addCustomBtn.style.borderColor = "#585b70"; };
    actions.appendChild(addCustomBtn);
    modal.appendChild(actions);

    const list = document.createElement("div");
    modal.appendChild(list);

    const updateCount = () => {
      const cards = list.querySelectorAll(".zorg-model-card").length;
      count.textContent = `${cards} missing model${cards !== 1 ? "s" : ""} found`;
    };

    const addCard = (model) => {
      const card = createModelCard(model, {
        onRemove: ({ modelName, isCustom }) => {
          if (!isCustom && modelName) {
            const ignored = getIgnoredModels();
            ignored.add(modelName);
            saveIgnoredModels(ignored);
            fetch("/model_downloader/registry/remove", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ model_name: modelName }),
            }).catch(() => {});
          }
          card.remove();
          updateCount();
        },
      });
      list.appendChild(card);
      updateCount();
    };

    addCustomBtn.onclick = () => {
      addCard({
        nodeId: null,
        nodeTitle: "Custom entry",
        nodeType: "manual",
        inputName: "manual",
        modelName: "",
        folder: "checkpoints",
        url: "",
        description: "",
        isCustom: true,
      });
    };

    for (const model of missingModels) {
      addCard(model);
    }
  }

  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  dialogEl = overlay;
}

// ── Model Card ─────────────────────────────────────────────────────
function createModelCard(model, options = {}) {
  const card = document.createElement("div");
  card.className = "zorg-model-card";
  Object.assign(card.style, {
    background: "#313244",
    borderRadius: "8px",
    padding: "16px",
    marginBottom: "12px",
    border: "1px solid #45475a",
  });

  // Model name
  const nameRow = document.createElement("div");
  Object.assign(nameRow.style, {
    marginBottom: "8px",
    display: "flex",
    gap: "8px",
    alignItems: "center",
    justifyContent: "space-between",
  });

  let modelNameInput = null;
  if (model.isCustom) {
    modelNameInput = inputField(model.modelName || "", "Model filename (e.g. model.safetensors)");
    modelNameInput.style.flex = "1";
    modelNameInput.style.fontSize = "13px";
    nameRow.appendChild(modelNameInput);
  } else {
    const nameLabel = document.createElement("strong");
    nameLabel.textContent = model.modelName;
    nameLabel.style.color = "#f38ba8";
    nameLabel.style.fontSize = "15px";
    nameRow.appendChild(nameLabel);
  }

  const removeBtn = document.createElement("button");
  removeBtn.textContent = "🗑 Remove";
  Object.assign(removeBtn.style, {
    background: "#45475a",
    color: "#cdd6f4",
    border: "1px solid #585b70",
    borderRadius: "6px",
    padding: "5px 10px",
    fontSize: "11px",
    fontWeight: "600",
    cursor: "pointer",
    whiteSpace: "nowrap",
    transition: "all 0.2s",
  });
  removeBtn.onmouseenter = () => { removeBtn.style.background = "#585b70"; removeBtn.style.borderColor = "#f38ba8"; };
  removeBtn.onmouseleave = () => { removeBtn.style.background = "#45475a"; removeBtn.style.borderColor = "#585b70"; };
  removeBtn.onclick = () => {
    const modelName = modelNameInput ? modelNameInput.value.trim() : model.modelName;
    if (options.onRemove) {
      options.onRemove({ modelName, isCustom: !!model.isCustom });
    } else {
      card.remove();
    }
  };
  nameRow.appendChild(removeBtn);
  card.appendChild(nameRow);

  // Info row: editable folder + node info
  const info = document.createElement("div");
  Object.assign(info.style, {
    fontSize: "12px",
    color: "#6c7086",
    marginBottom: "10px",
    display: "flex",
    gap: "8px",
    alignItems: "center",
    flexWrap: "wrap",
  });

  const folderLabel = document.createElement("span");
  folderLabel.textContent = "📂";
  info.appendChild(folderLabel);

  const folderInput = document.createElement("input");
  folderInput.type = "text";
  folderInput.value = model.folder;
  Object.assign(folderInput.style, {
    background: "#1e1e2e",
    color: "#89b4fa",
    border: "1px solid #585b70",
    borderRadius: "4px",
    padding: "3px 8px",
    fontSize: "12px",
    fontWeight: "600",
    width: "160px",
    outline: "none",
  });
  folderInput.onfocus = () => (folderInput.style.borderColor = "#89b4fa");
  folderInput.onblur = () => (folderInput.style.borderColor = "#585b70");
  folderInput.title = "Target folder in ComfyUI (editable)";
  info.appendChild(folderInput);

  const nodeInfo = document.createElement("span");
  nodeInfo.innerHTML = `🔧 ${escHtml(model.nodeTitle)} <em>(${escHtml(model.inputName)})</em>`;
  info.appendChild(nodeInfo);
  card.appendChild(info);

  // URL input + Find URL button
  const urlRow = document.createElement("div");
  Object.assign(urlRow.style, { display: "flex", gap: "8px", marginBottom: "8px" });

  const urlInput = inputField(model.url, "Paste download URL here…");
  urlInput.style.flex = "1";
  urlRow.appendChild(urlInput);

  const findBtn = document.createElement("button");
  findBtn.textContent = "🔍 Find URL";
  Object.assign(findBtn.style, {
    background: "#45475a",
    color: "#cdd6f4",
    border: "1px solid #585b70",
    borderRadius: "6px",
    padding: "8px 12px",
    fontSize: "12px",
    fontWeight: "600",
    cursor: "pointer",
    whiteSpace: "nowrap",
    transition: "all 0.2s",
  });
  findBtn.onmouseenter = () => { findBtn.style.background = "#585b70"; findBtn.style.borderColor = "#89b4fa"; };
  findBtn.onmouseleave = () => { findBtn.style.background = "#45475a"; findBtn.style.borderColor = "#585b70"; };
  findBtn.onclick = () => handleFindUrl(model, urlInput, findBtn);
  urlRow.appendChild(findBtn);
  card.appendChild(urlRow);

  // Token + Download row
  const actionRow = document.createElement("div");
  Object.assign(actionRow.style, { display: "flex", gap: "8px", alignItems: "center" });

  const savedToken = getHfToken();
  const tokenInput = inputField(savedToken, savedToken ? "🔑 Token loaded from Settings" : "Auth token (optional — set in Settings ⚙)");
  tokenInput.style.flex = "1";
  tokenInput.style.fontSize = "12px";
  if (savedToken) tokenInput.style.borderColor = "#a6e3a1";
  actionRow.appendChild(tokenInput);

  const downloadBtn = document.createElement("button");
  downloadBtn.textContent = "⬇ Download";
  Object.assign(downloadBtn.style, {
    background: "#89b4fa",
    color: "#1e1e2e",
    border: "none",
    borderRadius: "6px",
    padding: "8px 16px",
    fontSize: "13px",
    fontWeight: "600",
    cursor: "pointer",
    whiteSpace: "nowrap",
    transition: "background 0.2s",
  });
  downloadBtn.onmouseenter = () => (downloadBtn.style.background = "#74c7ec");
  downloadBtn.onmouseleave = () => (downloadBtn.style.background = "#89b4fa");
  actionRow.appendChild(downloadBtn);
  card.appendChild(actionRow);

  // Progress bar (hidden)
  const { container: progContainer, fill: progFill, text: progText } = createProgressBar();
  card.appendChild(progContainer);

  // Download handler
  downloadBtn.onclick = () =>
    handleDownload(model, urlInput, tokenInput, downloadBtn, card, progContainer, progFill, progText, folderInput, modelNameInput);

  return card;
}

// ── Find URL Handler ───────────────────────────────────────────────
async function handleFindUrl(model, urlInput, findBtn) {
  findBtn.disabled = true;
  findBtn.textContent = "⏳ Searching…";

  // Remove any existing search results dropdown
  const existingResults = findBtn.parentElement?.parentElement?.querySelector(".zorg-search-results");
  if (existingResults) existingResults.remove();

  try {
    const resp = await fetch("/model_downloader/search_hf", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: model.modelName }),
    });
    const data = await resp.json();

    if (data.results?.length) {
      showSearchResults(data.results, urlInput, findBtn);
    } else {
      // Fallback: open HuggingFace search in new tab
      const q = encodeURIComponent(model.modelName.replace(/\.safetensors|\.ckpt|\.pt|\.bin|\.pth/gi, ""));
      window.open(`https://huggingface.co/models?search=${q}`, "_blank");
    }
  } catch (e) {
    // Fallback: open HuggingFace search in new tab
    const q = encodeURIComponent(model.modelName.replace(/\.safetensors|\.ckpt|\.pt|\.bin|\.pth/gi, ""));
    window.open(`https://huggingface.co/models?search=${q}`, "_blank");
  } finally {
    findBtn.textContent = "🔍 Find URL";
    findBtn.disabled = false;
  }
}

function showSearchResults(results, urlInput, findBtn) {
  const card = findBtn.closest("div")?.parentElement;
  if (!card) return;

  // Remove old results
  const existing = card.querySelector(".zorg-search-results");
  if (existing) existing.remove();

  const container = document.createElement("div");
  container.className = "zorg-search-results";
  Object.assign(container.style, {
    background: "#1e1e2e",
    border: "1px solid #585b70",
    borderRadius: "6px",
    marginBottom: "8px",
    maxHeight: "160px",
    overflowY: "auto",
    fontSize: "12px",
  });

  for (const r of results) {
    const row = document.createElement("div");
    Object.assign(row.style, {
      padding: "8px 12px",
      borderBottom: "1px solid #313244",
      cursor: "pointer",
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      gap: "8px",
      transition: "background 0.15s",
    });
    row.onmouseenter = () => (row.style.background = "#313244");
    row.onmouseleave = () => (row.style.background = "transparent");

    const info = document.createElement("div");
    info.style.flex = "1";
    info.style.minWidth = "0";
    info.innerHTML =
      `<div style="color:#89b4fa;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escHtml(r.repo)}</div>` +
      `<div style="color:#6c7086;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escHtml(r.filename)}</div>`;

    const useBtn = document.createElement("button");
    useBtn.textContent = "Use";
    Object.assign(useBtn.style, {
      background: "#a6e3a1",
      color: "#1e1e2e",
      border: "none",
      borderRadius: "4px",
      padding: "4px 10px",
      fontSize: "11px",
      fontWeight: "700",
      cursor: "pointer",
      flexShrink: "0",
    });

    useBtn.onclick = (e) => {
      e.stopPropagation();
      urlInput.value = r.url;
      urlInput.style.borderColor = "#a6e3a1";
      container.remove();
    };

    row.onclick = () => {
      urlInput.value = r.url;
      urlInput.style.borderColor = "#a6e3a1";
      container.remove();
    };

    row.appendChild(info);
    row.appendChild(useBtn);
    container.appendChild(row);
  }

  // "Search on HuggingFace" fallback link
  const fallback = document.createElement("div");
  Object.assign(fallback.style, {
    padding: "6px 12px",
    textAlign: "center",
    color: "#89b4fa",
    cursor: "pointer",
    fontSize: "11px",
  });
  fallback.textContent = "🌐 Open HuggingFace search in browser →";
  fallback.onclick = () => {
    const q = encodeURIComponent(results[0]?.filename || "model");
    window.open(`https://huggingface.co/models?search=${q}`, "_blank");
  };
  container.appendChild(fallback);

  // Insert after the URL row
  const urlRow = findBtn.parentElement;
  urlRow.parentElement.insertBefore(container, urlRow.nextSibling);
}

// ── Download Handler ───────────────────────────────────────────────
async function handleDownload(model, urlInput, tokenInput, btn, card, progContainer, progFill, progText, folderInput, modelNameInput) {
  const url = urlInput.value.trim();
  if (!url) {
    urlInput.style.borderColor = "#f38ba8";
    urlInput.placeholder = "⚠ URL is required!";
    return;
  }

  const modelName = modelNameInput ? modelNameInput.value.trim() : model.modelName;
  if (!modelName) {
    if (modelNameInput) {
      modelNameInput.style.borderColor = "#f38ba8";
      modelNameInput.placeholder = "⚠ Model filename is required!";
    }
    return;
  }

  if (shouldSkipMissingValue(modelName)) {
    progContainer.style.display = "block";
    progText.textContent = "❌ Image/video/audio files are not allowed in missing model downloads.";
    return;
  }

  const folder = folderInput ? folderInput.value.trim() : model.folder;

  btn.disabled = true;
  btn.textContent = "⏳ Starting…";
  btn.style.background = "#585b70";
  btn.style.cursor = "default";
  progContainer.style.display = "block";

  try {
    // Save URL to registry (fire-and-forget)
    fetch("/model_downloader/registry/add", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model_name: modelName, url, folder }),
    });

    const resp = await fetch("/model_downloader/download", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url,
        folder,
        filename: modelName,
        token: tokenInput.value.trim(),
      }),
    });
    const result = await resp.json();
    if (result.error) throw new Error(result.error);

    pollProgress(result.download_id, btn, card, progFill, progText);
  } catch (e) {
    progText.textContent = "❌ " + e.message;
    progContainer.style.display = "block";
    resetBtn(btn);
  }
}

function pollProgress(downloadId, btn, card, progFill, progText) {
  const poll = setInterval(async () => {
    try {
      const resp = await fetch(`/model_downloader/progress?download_id=${encodeURIComponent(downloadId)}`);
      const p = await resp.json();

      if (p.total > 0) {
        const pct = Math.round((p.progress / p.total) * 100);
        progFill.style.width = pct + "%";
        progText.textContent = `${mb(p.progress)} / ${mb(p.total)} (${pct}%)`;
        btn.textContent = `⬇ ${pct}%`;
      } else if (p.progress > 0) {
        progFill.style.width = "50%";
        progText.textContent = `${mb(p.progress)} downloaded…`;
        btn.textContent = "⬇ Downloading…";
      }

      if (p.status === "completed") {
        clearInterval(poll);
        progFill.style.width = "100%";
        progFill.style.background = "#a6e3a1";
        progText.textContent = "✅ Download complete!";
        btn.textContent = "✅ Done";
        btn.style.background = "#a6e3a1";
        card.style.borderColor = "#a6e3a1";
      } else if (p.status === "error") {
        clearInterval(poll);
        progFill.style.background = "#f38ba8";
        progText.textContent = "❌ " + (p.error || "Unknown error");
        resetBtn(btn);
      }
    } catch (_) {
      /* network hiccup, keep polling */
    }
  }, 1000);
}

// ── UI Helpers ─────────────────────────────────────────────────────
function inputField(value, placeholder) {
  const el = document.createElement("input");
  el.type = "text";
  el.value = value;
  el.placeholder = placeholder;
  Object.assign(el.style, {
    background: "#1e1e2e",
    color: "#cdd6f4",
    border: "1px solid #585b70",
    borderRadius: "6px",
    padding: "8px 12px",
    fontSize: "13px",
    outline: "none",
  });
  el.onfocus = () => (el.style.borderColor = "#89b4fa");
  el.onblur = () => (el.style.borderColor = "#585b70");
  return el;
}

function createProgressBar() {
  const container = document.createElement("div");
  Object.assign(container.style, { marginTop: "8px", display: "none" });

  const bar = document.createElement("div");
  Object.assign(bar.style, {
    height: "6px",
    background: "#45475a",
    borderRadius: "3px",
    overflow: "hidden",
  });

  const fill = document.createElement("div");
  Object.assign(fill.style, {
    height: "100%",
    width: "0%",
    background: "#89b4fa",
    borderRadius: "3px",
    transition: "width 0.3s",
  });
  bar.appendChild(fill);
  container.appendChild(bar);

  const text = document.createElement("div");
  Object.assign(text.style, {
    fontSize: "11px",
    color: "#6c7086",
    marginTop: "4px",
    textAlign: "center",
  });
  container.appendChild(text);

  return { container, fill, text };
}

function resetBtn(btn) {
  btn.textContent = "⬇ Retry";
  btn.style.background = "#89b4fa";
  btn.style.cursor = "pointer";
  btn.disabled = false;
}

function mb(bytes) {
  return (bytes / 1048576).toFixed(1) + " MB";
}

function escHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

function shouldSkipMissingValue(name) {
  if (!name || typeof name !== "string") return true;
  const normalized = name.trim().toLowerCase();
  for (const ext of MEDIA_EXTENSIONS) {
    if (normalized.endsWith(ext)) return true;
  }
  return false;
}

function getIgnoredModels() {
  try {
    const raw = localStorage.getItem("zorg_missing_ignored_models");
    const items = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(items) ? items : []);
  } catch (_) {
    return new Set();
  }
}

function saveIgnoredModels(ignoredSet) {
  try {
    localStorage.setItem("zorg_missing_ignored_models", JSON.stringify(Array.from(ignoredSet)));
  } catch (_) {}
}
