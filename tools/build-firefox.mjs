import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const source = path.join(root, "chromium");
const out = path.join(root, "build", "firefox-src");

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.cpSync(source, out, { recursive: true });

const manifestPath = path.join(out, "manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
delete manifest.version_name;

manifest.background = {
  scripts: ["performance-background.js"],
};

manifest.browser_specific_settings = {
  gecko: {
    id: "better-chatgpt@marcmy.github.io",
    strict_min_version: "142.0",
    data_collection_permissions: {
      required: ["none"],
    },
  },
};

fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

console.log(`Firefox source staged at ${path.relative(root, out)}`);
console.log(`BetterChatGPT v${manifest.version}`);
console.log(`Gecko ID: ${manifest.browser_specific_settings.gecko.id}`);
