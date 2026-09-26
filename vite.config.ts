import { defineConfig, Plugin } from "vite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

/** Dev-only: POST /__shot {name, data(dataURL)} → writes .shots/<name>.png */
function shotSaver(): Plugin {
  return {
    name: "shot-saver",
    configureServer(server) {
      server.middlewares.use("/__layout", (req, res) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end();
          return;
        }
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          try {
            const payload = JSON.parse(body);
            const dir = path.join(rootDir, ".shots");
            fs.mkdirSync(dir, { recursive: true });
            const safe = String(payload.name).replace(/[^a-z0-9-_]/gi, "_").slice(0, 80);
            fs.writeFileSync(path.join(dir, `${safe}.layout.json`), JSON.stringify(payload, null, 2));
            res.end("ok");
          } catch (e) {
            res.statusCode = 500;
            res.end(String(e));
          }
        });
      });
      server.middlewares.use("/__grid", (req, res) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end();
          return;
        }
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          try {
            const { name, w, h, data } = JSON.parse(body);
            const dir = path.join(rootDir, ".shots");
            fs.mkdirSync(dir, { recursive: true });
            const safe = String(name).replace(/[^a-z0-9-_]/gi, "_").slice(0, 80);
            fs.writeFileSync(path.join(dir, `${safe}.grid.json`), JSON.stringify({ w, h, data }));
            res.end("ok");
          } catch (e) {
            res.statusCode = 500;
            res.end(String(e));
          }
        });
      });
      server.middlewares.use("/__shot", (req, res) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end();
          return;
        }
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          try {
            const { name, data } = JSON.parse(body);
            const dir = path.join(rootDir, ".shots");
            fs.mkdirSync(dir, { recursive: true });
            const safe = String(name).replace(/[^a-z0-9-_]/gi, "_").slice(0, 80);
            fs.writeFileSync(
              path.join(dir, `${safe}.png`),
              Buffer.from(String(data).replace(/^data:image\/png;base64,/, ""), "base64")
            );
            res.end("ok");
          } catch (e) {
            res.statusCode = 500;
            res.end(String(e));
          }
        });
      });
    }
  };
}

export default defineConfig({
  base: "./",
  plugins: [shotSaver()],
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks: {
          three: ["three"],
          screenshot: ["modern-screenshot"]
        }
      }
    }
  },
  server: {
    port: 5173
  }
});
