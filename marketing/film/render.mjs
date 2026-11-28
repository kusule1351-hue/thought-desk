// The marketing film, pass 2: every frame of film.html as a picture, then the pictures as a video.
//
//   node marketing/film/render.mjs <frames of the app> <folder for the film's frames> [out.mp4]
//
// FILM_EVERY=15 draws only every fifteenth frame (a look at the cut, no video). ffmpeg must be on the PATH.
// FILM_FROM=920 draws again only from that frame on.

import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [APP, OUT, VIDEO] = process.argv.slice(2);
if (!APP || !OUT) throw new Error('Name the folder of app frames and a folder for the film.');
const EVERY = Number(process.env.FILM_EVERY || 1);
const PUBLIC = new URL('../../site/public/', import.meta.url);
const url = (path) => pathToFileURL(path).href;

const marks = JSON.parse(await readFile(`${APP}/marks.json`, 'utf8'));
const stills = ['home', 'calendar', 'database'].map((name) => new URL(`img/${name}-${marks.theme}.webp`, PUBLIC).href);

// FILM_FROM=920 draws again only from that frame on, over the frames already there (a change to the end alone).
const FROM = Number(process.env.FILM_FROM || 0);
if (!FROM) await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => console.log('PAGE ERROR', String(e)));
  await page.goto(new URL('./film.html', import.meta.url).href);
  const total = await page.evaluate((cfg) => window.setup(cfg), { marks, frames: url(APP), stills });
  console.log(`${total} frames, ${(total / 30).toFixed(1)} s`);
  for (let f = FROM; f < total; f += EVERY) {
    await page.evaluate((f) => window.draw(f), f);
    await writeFile(`${OUT}/${String(Math.floor(f / EVERY)).padStart(5, '0')}.png`, await page.screenshot({ type: 'png' }));
    if (f % 150 === 0) console.log(f);
  }
} finally {
  await browser.close();
}

if (VIDEO && EVERY === 1) {
  execFileSync(
    'ffmpeg',
    ['-v', 'error', '-y', '-framerate', '30', '-i', `${OUT}/%05d.png`, '-vf', 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p', '-c:v', 'libx264', '-preset', 'slow', '-crf', '15', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-movflags', '+faststart', VIDEO],
    { stdio: 'inherit' },
  );
  console.log(fileURLToPath(pathToFileURL(VIDEO)));
}
