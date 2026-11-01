const { chromium } = require('/opt/node-tools/node_modules/playwright');
const fs = require('fs');
const OUT = process.argv[2] || './';
(async () => {
  const b = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
  const pg = await b.newPage({ viewport: { width: 512, height: 512 } });
  await pg.goto('http://localhost:8099/tools/render3d/render.html');
  await pg.evaluate(() => window.ready);
  for (const r of [-30, -15, 0, 15, 30]) {
    const d = await pg.evaluate(([r]) => { window.view([0, 10, 0]); return window.shot(Math.PI, 0, r * Math.PI / 180); }, [r]);
    fs.writeFileSync(OUT + 'bank_' + r + '.png', Buffer.from(d.split(',')[1], 'base64'));
  }
  await b.close();
})();
