// Renders the ad frame by frame: the animation page (site/index.html) is driven with window.__setTime(t), every frame is a
// Playwright screenshot piped into ffmpeg, then the synthesized music is muxed in (H.264 + AAC, 30 fps).
//   node marketing/linkedin-ad/render.mjs landscape|portrait       -> out/biforge-linkedin-<size>.mp4
//   node marketing/linkedin-ad/render.mjs landscape --stills 1,4,8 -> out/stills/<fmt>-<t>.png (no video, for review)
import { spawn } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const { chromium } = createRequire(join(here, "../../app/package.json"))("playwright-core");
const fmt = process.argv[2] === "portrait" ? "portrait" : "landscape";
const size = fmt === "portrait" ? { width: 1080, height: 1350 } : { width: 1920, height: 1080 };
const si = process.argv.indexOf("--stills");
const stills = si > 0 ? process.argv[si + 1].split(",").map(Number) : null;
const tl = JSON.parse(readFileSync(join(here, "site/timeline.json"), "utf8"));
const fps = tl.fps, total = Math.round(tl.duration * fps);
const mime = { ".html": "text/html", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".csv": "text/csv", ".js": "text/javascript" };

const server = createServer((req, res) => {
  const p = resolve(here, "." + decodeURIComponent(req.url.split("?")[0]));
  if (!p.startsWith(here) || !existsSync(p) || !statSync(p).isFile()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "Content-Type": mime[extname(p)] ?? "application/octet-stream" });
  createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/site/index.html?fmt=${fmt}`;

const browser = await chromium.launch({ channel: "msedge" });
const page = await (await browser.newContext({ viewport: size, deviceScaleFactor: 1 })).newPage();
page.on("pageerror", (e) => console.log("PAGEERROR", e));
await page.goto(url);
await page.waitForFunction(() => window.__ready === true, null, { timeout: 60000 });

try {
  if (stills) {
    mkdirSync(join(here, "out/stills"), { recursive: true });
    for (const t of stills) {
      await page.evaluate((x) => window.__setTime(x), t);
      await page.screenshot({ path: join(here, `out/stills/${fmt}-${t}.png`) });
    }
    console.log("stills done");
  } else {
    mkdirSync(join(here, "out"), { recursive: true });
    const out = join(here, `out/biforge-linkedin-${size.width}x${size.height}.mp4`);
    const music = join(here, "out/music.wav");
    if (!existsSync(music)) throw new Error("run audio/make_music.py first");
    const ff = spawn("ffmpeg", ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(fps), "-c:v", "png", "-i", "-", "-i", music,
      "-c:v", "libx264", "-preset", "slow", "-crf", "16", "-pix_fmt", "yuv420p", "-r", String(fps), "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", out], { stdio: ["pipe", "inherit", "inherit"] });
    const done = new Promise((r) => ff.on("close", r));
    for (let i = 0; i < total; i++) {
      await page.evaluate((x) => window.__setTime(x), i / fps);
      const png = await page.screenshot({ type: "png" });
      if (!ff.stdin.write(png)) await new Promise((r) => ff.stdin.once("drain", r));
      if (i % 90 === 0) console.log("frame", i, "/", total);
    }
    ff.stdin.end();
    console.log("ffmpeg exit", await done, out);
  }
} finally {
  await browser.close();
  server.close();
}
