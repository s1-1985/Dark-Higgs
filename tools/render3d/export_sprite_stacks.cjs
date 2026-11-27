// Run from the repository root with Playwright and a local HTTP server.
// python3 -m http.server 8099
// node tools/render3d/export_sprite_stacks.cjs
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');

async function main() {
    const browser = await chromium.launch({
        headless: true,
        executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    });
    try {
        const page = await browser.newPage();
        const root = process.env.TEST_BASE_URL || 'http://127.0.0.1:8099';
        const url = new URL('/prototype/index.html', root);
        const atlases = await page.goto(url.href, { waitUntil: 'domcontentloaded' }).then(() => page.evaluate(async () => {
            const roles = ['assault', 'stealth', 'carrier', 'fighter', 'mech'];
            return Promise.all(roles.map(async role => {
                const img = SPRITES['f2_helios_' + role];
                await img.decode();
                const stack = MobileSpriteStack.build(img, role);
                if (!stack) throw new Error('Unable to build atlas for ' + role);
                return { role, png: stack.atlas.toDataURL('image/png').split(',')[1] };
            }));
        }));
        const output = path.resolve(__dirname, '../../prototype/assets/stacks');
        await fs.mkdir(output, { recursive: true });
        await Promise.all(atlases.map(({ role, png }) =>
            fs.writeFile(path.join(output, 'helios_' + role + '.png'), Buffer.from(png, 'base64'))));
        console.log('Exported five 16-layer atlases.');
    } finally {
        await browser.close();
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
