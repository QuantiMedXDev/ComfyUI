import { app } from "../../scripts/app.js";

// Register Zorg Platform credentials in the ComfyUI Settings panel.
app.registerExtension({
  name: "ZorgUploader.Settings",

  init() {
    // 1) Email (first)
    app.ui.settings.addSetting({
      id: "Zorg.Email",
      category: ["Zorg Platform", "Credentials", "Email"],
      name: "Email",
      tooltip: "Your Zorg platform login email address.",
      type: "text",
      defaultValue: "",
    });

    // 2) Password (second — masked via MutationObserver below)
    app.ui.settings.addSetting({
      id: "Zorg.Password",
      category: ["Zorg Platform", "Credentials", "Password"],
      name: "Password",
      tooltip: "Your Zorg platform password (stored in server-side settings).",
      type: "text",
      defaultValue: "",
    });

    // 3) API URL (third)
    app.ui.settings.addSetting({
      id: "Zorg.ApiUrl",
      category: ["Zorg Platform", "Credentials", "API URL"],
      name: "API URL",
      tooltip:
        "Zorg API base URL (e.g. https://api.zorgsocial.com or http://localhost:8000).",
      type: "text",
      defaultValue: "http://localhost:8000",
    });

    // Convert the Password text input into type="password" whenever it appears.
    // The Vue-based settings panel renders inputs dynamically, so we observe DOM
    // mutations and patch any input whose setting id is "Zorg.Password".
    const maskPasswordInputs = () => {
      // The settings panel renders inputs inside elements that reference the
      // setting id. We look for any visible text input whose ancestor or
      // associated label/model contains "Zorg.Password" or whose value matches.
      document.querySelectorAll('input[type="text"]').forEach((input) => {
        // Check if this input is inside a settings row for Zorg.Password.
        // The ComfyUI Vue frontend sets a model attribute or the closest
        // container has the setting id in a data attribute or label text.
        const container = input.closest("[class]");
        if (!container) return;

        // Look for the label text "Password" within the same settings row
        const row =
          input.closest("tr") ||
          input.closest("[class*='setting']") ||
          input.parentElement?.parentElement;
        if (!row) return;

        const labels = row.querySelectorAll(
          "label, span, td, div, [class*='label']"
        );
        let isPasswordField = false;
        labels.forEach((el) => {
          const text = el.textContent?.trim();
          if (text === "Password") {
            isPasswordField = true;
          }
        });

        if (isPasswordField && input.type === "text") {
          input.type = "password";
          input.autocomplete = "off";
        }
      });
    };

    // Run once now (in case settings panel is already open)
    maskPasswordInputs();

    // Observe DOM changes to catch when the settings panel opens
    const observer = new MutationObserver(() => {
      maskPasswordInputs();
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
  },
});
