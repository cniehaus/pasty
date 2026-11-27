// Renders the SVG icon sources in assets/icon to PNG.
//
//   npm run icons
//
// Writes assets/icon/app-icon.png (1024 px, input for `tauri icon`) and
// src-tauri/icons/tray-icon.png (menu bar template image, 44 px = 22 pt @2x).

import { readFileSync, writeFileSync } from "node:fs";
import { Resvg } from "@resvg/resvg-js";

function render(svgPath, pngPath, width) {
  const svg = readFileSync(svgPath, "utf8");
  const png = new Resvg(svg, { fitTo: { mode: "width", value: width } }).render().asPng();
  writeFileSync(pngPath, png);
  console.log(`${pngPath} (${width} px)`);
}

render("assets/icon/app-icon.svg", "assets/icon/app-icon.png", 1024);
render("assets/icon/tray-icon.svg", "src-tauri/icons/tray-icon.png", 44);
