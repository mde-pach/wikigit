import { statSync } from "node:fs";
import { join, normalize } from "node:path";

// Serves the production build the way web.nginx.conf does: `try_files $uri
// $uri/index.html`, else the 404 shell (which boots the SPA for unbuilt routes).
const root = join(import.meta.dir, "..", "dist");
const port = Number(process.env.PORT ?? 4329);

const isFile = (p: string) => statSync(p, { throwIfNoEntry: false })?.isFile();

Bun.serve({
  port,
  hostname: "127.0.0.1",
  fetch(req) {
    const path = normalize(decodeURIComponent(new URL(req.url).pathname));
    const hit = [join(root, path), join(root, path, "index.html")].find(isFile);
    if (hit) return new Response(Bun.file(hit));
    return new Response(Bun.file(join(root, "404.html")), {
      status: 404,
      headers: { "Content-Type": "text/html" },
    });
  },
});
console.log(`serving dist on :${port}`);
