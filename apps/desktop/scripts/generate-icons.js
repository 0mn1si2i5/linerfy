// Render the vector master with the Electron version already used by the app.
// Run from apps/desktop: pnpm exec electron scripts/generate-icons.js
const { app, BrowserWindow } = require("electron");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const assets = path.resolve(__dirname, "../assets");

app.whenReady().then(async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "linerfy-icons-"));
  let window;
  let exitCode = 0;
  try {
    window = new BrowserWindow({
      width: 1024,
      height: 1024,
      useContentSize: true,
      show: false,
      transparent: true,
      frame: false,
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    const svg = await fs.readFile(path.join(assets, "app-icon.svg"), "utf8");
    const document =
      '<html style="background:transparent"><body style="margin:0">' +
      svg +
      "</body></html>";
    await window.loadURL(
      "data:text/html;charset=utf-8," + encodeURIComponent(document),
    );
    const image = await window.webContents.capturePage();
    const master = image.resize({ width: 1024, height: 1024, quality: "best" });
    await fs.writeFile(path.join(assets, "app-icon.png"), master.toPNG());

    if (process.platform === "darwin") {
      const iconset = path.join(temporary, "app-icon.iconset");
      await fs.mkdir(iconset);
      for (const size of [16, 32, 128, 256, 512]) {
        for (const scale of [1, 2]) {
          const pixels = size * scale;
          const suffix = scale === 2 ? "@2x" : "";
          await fs.writeFile(
            path.join(iconset, `icon_${size}x${size}${suffix}.png`),
            master
              .resize({ width: pixels, height: pixels, quality: "best" })
              .toPNG(),
          );
        }
      }
      execFileSync("iconutil", [
        "-c",
        "icns",
        iconset,
        "-o",
        path.join(assets, "app-icon.icns"),
      ]);
    }
    console.log(
      "Rendered app-icon.png" +
        (process.platform === "darwin" ? " and app-icon.icns" : ""),
    );
  } catch (error) {
    console.error(error);
    exitCode = 1;
  } finally {
    window?.destroy();
    await fs.rm(temporary, { recursive: true, force: true });
  }
  app.exit(exitCode);
});
