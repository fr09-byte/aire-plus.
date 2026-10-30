import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const routes = {
  "/api/air": (await import("../api/air.js")).default,
  "/api/alerts": (await import("../api/alerts.js")).default,
  "/api/assistant": (await import("../api/assistant.js")).default,
  "/api/cron": (await import("../api/cron.js")).default,
};
const server = http.createServer(async (req, res) => {
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (data) => {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(data));
    return res;
  };
  const path = new URL(req.url, "http://localhost").pathname;
  if (routes[path]) {
    try {
      return await routes[path](req, res);
    } catch {
      res.status(500).json({ error: "Error del servidor local." });
      return;
    }
  }
  const file =
    path === "/" || path === "/index.html"
      ? "index.html"
      : path === "/qa-mobile.html"
        ? "dist/qa-mobile.html"
        : null;
  if (!file) {
    res.statusCode = 404;
    res.end("Not found");
    return;
  }
  try {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(await readFile(join(root, file)));
  } catch {
    res.statusCode = 404;
    res.end("Not found");
  }
});
const port = Number(process.env.PORT || 4173);
server.listen(port, "0.0.0.0", () =>
  console.log(`AIRE+ development server listening on ${port}`),
);
