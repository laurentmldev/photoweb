const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

const SITE_CONFIG_PATH = path.join(__dirname, "..", "config", "site.yaml");

/**
 * Loads the global site configuration (theme, navigation, footer, ...)
 * from config/site.yaml. Read fresh from disk on every call so that
 * editing the YAML file takes effect without restarting the server.
 */
function loadSiteConfig() {
  const raw = fs.readFileSync(SITE_CONFIG_PATH, "utf8");
  const data = yaml.load(raw) || {};

  // Sensible defaults in case some keys are missing from the YAML file.
  return {
    site: {
      title: "Photography",
      tagline: "",
      logoText: "Photography",
      language: "en",
      ...data.site,
    },
    theme: {
      primaryColor: "#111111",
      secondaryColor: "#ffffff",
      accentColor: "#c9a227",
      mutedColor: "#666666",
      borderColor: "#e5e5e5",
      headerBackgroundColor: "#ffffff",
      footerBackgroundColor: "#ffffff",
      headingFont: "Georgia, serif",
      bodyFont: "Helvetica, Arial, sans-serif",
      googleFontsUrl: "",
      ...data.theme,
    },
    navigation: data.navigation || [],
    footer: data.footer || {},
  };
}

/**
 * Generic YAML file reader/loader, used for per-page content files
 * (content/home.yaml, content/projects.yaml, content/contact.yaml, ...).
 */
function loadYamlFile(relativeOrAbsolutePath) {
  const fullPath = path.isAbsolute(relativeOrAbsolutePath)
    ? relativeOrAbsolutePath
    : path.join(__dirname, "..", relativeOrAbsolutePath);
  const raw = fs.readFileSync(fullPath, "utf8");
  return yaml.load(raw) || {};
}

module.exports = { loadSiteConfig, loadYamlFile };
