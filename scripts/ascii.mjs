#!/usr/bin/env node
// Render a .shots/*.grid.json frame probe as terminal ASCII (luminance + hue marks).
import fs from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("usage: node scripts/ascii.mjs .shots/<name>.grid.json");
  process.exit(1);
}
const { w, h, data } = JSON.parse(fs.readFileSync(file, "utf8"));

const ramp = " .:-=+*#%@";
let sum = 0;
let black = 0;
let bright = 0;
const lines = [];
for (let gy = h - 1; gy >= 0; gy--) {
  // readPixels row 0 is the BOTTOM of the frame — print flipped
  let line = "";
  for (let gx = 0; gx < w; gx++) {
    const i = (gy * w + gx) * 3;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    sum += lum;
    if (lum < 8) black++;
    if (lum > 200) bright++;
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    const sat = mx - mn;
    let ch;
    if (sat > 26 && mx > 60) {
      // hue-marked cell: C cyan, T teal, A amber, R red, B blue, G green
      const up = mx > 150;
      if (r > g && r > b) ch = g > b ? "A" : "R";
      else if (g >= r && g >= b) ch = b > r ? "T" : "G";
      else ch = g > r ? "C" : "B";
      if (!up) ch = ch.toLowerCase();
    } else {
      ch = ramp[Math.min(ramp.length - 1, Math.floor((lum / 255) * ramp.length))];
    }
    line += ch;
  }
  lines.push(line);
}
console.log(lines.join("\n"));
console.log(
  `mean=${(sum / (w * h)).toFixed(1)} black%=${((black / (w * h)) * 100).toFixed(0)} bright%=${((bright / (w * h)) * 100).toFixed(1)}`
);
