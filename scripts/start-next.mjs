import { spawn } from "node:child_process";

const port = process.env.PORT || "8780";
const host = process.env.HOSTNAME || "0.0.0.0";
const nextBin = process.platform === "win32"
  ? "node_modules/next/dist/bin/next"
  : "node_modules/.bin/next";

const child = spawn(process.execPath, [nextBin, "start", "-H", host, "-p", port], {
  stdio: "inherit",
  env: process.env,
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
