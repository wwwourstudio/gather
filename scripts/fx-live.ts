/**
 * Live check of the camera background effects in the real app. Two fake cameras:
 *   - Chromium's built-in one, which is a bright green frame: Green screen must find the screen (no warning);
 *   - a plain room with no screen (written here as a .y4m): Green screen must say so, and its button must
 *     switch to Blur. Blur and Replace must never show the warning.
 *
 *   node server.js & node scripts/fx-live.ts      # screenshots in audit/screens/fx-*.png
 */
const { chromium } = require('playwright') as typeof import('playwright');
const fs = require('node:fs') as typeof import('node:fs');
const os = require('node:os') as typeof import('node:os');
const path = require('node:path') as typeof import('node:path');

const BASE = (process.env.GATHER_URL || 'http://localhost:8080').replace(/\/$/, '');
const OUT = path.resolve(__dirname, '..', 'audit', 'screens');

/** One 640×360 frame of a beige room with a bookcase and a person-ish shape, as YUV 4:2:0 (Chromium loops it). */
function roomY4m(): string {
  const W = 640, H = 360;
  const yuv = (r: number, g: number, b: number): [number, number, number] => [
    0.257 * r + 0.504 * g + 0.098 * b + 16, -0.148 * r - 0.291 * g + 0.439 * b + 128, 0.439 * r - 0.368 * g - 0.071 * b + 128];
  const boxes: Array<[number, number, number, number, [number, number, number]]> = [
    [420, 40, 180, 260, [58, 46, 38]], [240, 120, 160, 240, [44, 74, 122]], [280, 50, 80, 90, [217, 162, 126]]];
  const at = (x: number, y: number): [number, number, number] => {
    for (const [bx, by, bw, bh, c] of boxes) if (x >= bx && x < bx + bw && y >= by && y < by + bh) return yuv(...c);
    return yuv(184, 168, 144);
  };
  const Y = Buffer.alloc(W * H), U = Buffer.alloc(W * H / 4), V = Buffer.alloc(W * H / 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) Y[y * W + x] = Math.round(at(x, y)[0]);
  for (let y = 0; y < H / 2; y++) for (let x = 0; x < W / 2; x++) { const c = at(x * 2, y * 2); U[y * W / 2 + x] = Math.round(c[1]); V[y * W / 2 + x] = Math.round(c[2]); }
  const file = path.join(os.tmpdir(), 'gather-room.y4m');
  fs.writeFileSync(file, Buffer.concat([Buffer.from(`YUV4MPEG2 W${W} H${H} F30:1 Ip A1:1 C420jpeg\nFRAME\n`), Y, U, V]));
  return file;
}

async function run(camera: string | null, label: string, expectWarning: boolean): Promise<boolean> {
  const args = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--use-gl=angle', '--enable-unsafe-swiftshader'];
  if (camera) args.push(`--use-file-for-fake-video-capture=${camera}`);
  const browser = await chromium.launch({ args });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto(`${BASE}/`);
  await page.click('#enterStage'); await page.fill('#enterName', 'Host'); await page.click('#enterGo');
  await page.waitForSelector('#inviteDlg[open]'); await page.keyboard.press('Escape');
  await page.click('#userBtn'); await page.click('#settingsTop'); // Settings lives in the account menu
  let ok = true;
  for (const fx of ['blur', 'image', 'green']) {
    await page.click(`#bgFxSeg button[data-fx="${fx}"]`);
    await page.waitForTimeout(fx === 'green' ? 3500 : 2500);
    const warn = await page.isVisible('#bgFxNoScreen');
    console.log(`${label} / ${fx}: no-screen warning ${warn ? 'shown' : 'hidden'}`);
    if (warn !== (fx === 'green' && expectWarning)) ok = false;
    if (fx === 'green') { await page.locator('#bgFxSeg').scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(OUT, `fx-green-${label}.png`) }); }
  }
  if (expectWarning) {
    await page.click('#bgFxNoScreen [data-fx-switch="blur"]');
    const now = await page.getAttribute('#bgFxSeg button.on', 'data-fx');
    const hidden = !(await page.isVisible('#bgFxNoScreen'));
    console.log(`${label}: "Use Blur" switched to ${now}, warning hidden: ${hidden}`);
    if (now !== 'blur' || !hidden) ok = false;
  }
  if (errors.length) { console.log('page errors', errors); ok = false; }
  await browser.close();
  return ok;
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT, { recursive: true });
  const a = await run(null, 'green-camera', false);
  const b = await run(roomY4m(), 'room-camera', true);
  console.log(a && b ? 'fx live check passed' : 'FAIL fx live check');
  process.exit(a && b ? 0 : 1);
}
void main();
