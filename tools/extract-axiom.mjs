import fs from "fs";

const html = fs.readFileSync("C:/Users/bexgo/Downloads/Axiom Terminal.html", "utf8");
const idx = html.indexOf('"<!DOCTYPE html>');
if (idx < 0) {
  console.error("template not found");
  process.exit(1);
}
let end = html.indexOf('"\n', idx + 1);
const raw = JSON.parse(html.slice(idx, end + 1));
const styles = [...raw.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]);
console.log("style blocks:", styles.length);
for (let i = 0; i < styles.length; i++) {
  const css = styles[i];
  if (css.includes("05080f") || css.includes("rail") || css.includes("terminal") || css.includes("panel")) {
    console.log("\n=== STYLE BLOCK", i, "len", css.length, "===");
    console.log(css.slice(0, 18000));
  }
}
const classNames = [...new Set([...raw.matchAll(/className[=:][\s"']+([a-zA-Z0-9_\s-]+)/g)].map((m) => m[1].trim()))];
console.log("\n=== REACT className strings ===");
console.log(classNames.slice(0, 80).join("\n"));
fs.writeFileSync("tools/axiom-styles.css", styles[1]);
const gridIdx = raw.indexOf("grid1a");
console.log("grid1a at", gridIdx);
if (gridIdx > 0) fs.writeFileSync("tools/axiom-html.txt", raw.slice(gridIdx - 500, gridIdx + 12000));
