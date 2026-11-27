// Horizontal cross-sections in the sprite plane. The original sprite supplies
// the hull footprint and paint. Geometry (including where the roof rises)
// comes from the silhouette and the profile for each unit class.
const MobileSpriteStack = (() => {
    const LAYERS = 16;
    const COLUMNS = 4;
    const RIM = 5;
    const CACHE_LIMIT = 12;
    const profiles = {
        assault: { size: 192, lift: 0.075, rim: 5, max: 14 },
        stealth: { size: 192, lift: 0.064, rim: 4, max: 13 },
        carrier: { size: 192, lift: 0.090, rim: 6, max: 15 },
        fighter: { size: 128, lift: 0.115, rim: 4, max: 13 },
        mech:    { size: 128, lift: 0.095, rim: 5, max: 14 },
    };

    // Relative upper-section widths, sampled stern → bow from the
    // generated height studies for the original Helios paint. The source
    // sprite's silhouette still clips every section for every faction.
    const upperGuide = {
        assault: [6, 9, 9, 8, 8, 7, 7, 6, 6, 5, 5, 4],
        stealth: [5, 6, 8, 8, 7, 6, 4, 4, 3, 3, 3, 3],
        carrier: [9, 8, 5, 6, 4, 3, 2, 1, 4, 4, 4, 3],
        fighter: [4, 5, 9, 9, 8, 7, 5, 4, 4, 4, 3, 3],
    };

    const atlases = new Map();
    const queued = [];
    let scheduled = false;

    function smooth(lo, hi, value) {
        const t = Math.max(0, Math.min(1, (value - lo) / (hi - lo)));
        return t * t * (3 - 2 * t);
    }

    function sectionRoof(role, x, y, fromHelmet) {
        // x grows from stern to bow. Each y is measured from the middle of
        // the occupied part of that column, so an offset hull follows its
        // own spine rather than an arbitrary line through the canvas.
        const spine = 1 - smooth(0.12, 0.88, Math.abs(y));
        switch (role) {
        case 'assault':
            return spine * (1 - 0.62 * smooth(0.54, 0.99, x));
        case 'stealth':
            return Math.pow(spine, 2) * (1 - 0.58 * smooth(0.42, 0.98, x));
        case 'carrier': {
            const islands = smooth(0.24, 0.51, Math.abs(y)) * (1 - smooth(0.62, 0.91, Math.abs(y)));
            return Math.max(0.43 * spine, islands * (1 - 0.66 * smooth(0.78, 0.98, x)));
        }
        case 'fighter': {
            const cockpit = (1 - smooth(0.34, 0.98, x)) * spine;
            const engines = (1 - smooth(0.24, 0.63, x)) * smooth(0.33, 0.60, Math.abs(y));
            return Math.max(cockpit, engines * 0.78);
        }
        default:
            // The Tech art already has a humanoid pose. Let each connected
            // limb keep its shape and raise the broad parts of the armor.
            const armor = 1 - 0.45 * smooth(0.53, 0.76, fromHelmet);
            return (0.54 + 0.35 * spine) * armor;
        }
    }

    function silhouette(pixels, width, height) {
        const top = new Int16Array(width).fill(height);
        const bottom = new Int16Array(width).fill(-1);
        let left = width, right = -1, minY = height, maxY = -1;
        const distance = new Uint16Array(width * height);
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const i = y * width + x;
                if (pixels[i * 4 + 3] < 128) continue;
                top[x] = Math.min(top[x], y); bottom[x] = Math.max(bottom[x], y);
                left = Math.min(left, x); right = Math.max(right, x);
                minY = Math.min(minY, y); maxY = Math.max(maxY, y);
                distance[i] = Math.min(8192, 3 * Math.min(x + 1, width - x, y + 1, height - y));
            }
        }
        // Chamfer distance to the edge. This also bevels the edges of
        // empty spaces inside the sprite and thin protrusions.
        for (const direction of [1, -1]) {
            const startY = direction === 1 ? 0 : height - 1;
            const startX = direction === 1 ? 0 : width - 1;
            for (let y = startY; y >= 0 && y < height; y += direction) {
                for (let x = startX; x >= 0 && x < width; x += direction) {
                    const i = y * width + x;
                    if (!distance[i]) continue;
                    const prevX = x - direction, prevY = y - direction;
                    if (prevX >= 0 && prevX < width) distance[i] = Math.min(distance[i], distance[y * width + prevX] + 3);
                    if (prevY < 0 || prevY >= height) continue;
                    distance[i] = Math.min(distance[i], distance[prevY * width + x] + 3);
                    if (x > 0) distance[i] = Math.min(distance[i], distance[prevY * width + x - 1] + 4);
                    if (x + 1 < width) distance[i] = Math.min(distance[i], distance[prevY * width + x + 1] + 4);
                }
            }
        }
        return { top, bottom, left, right, minY, maxY, distance };
    }

    function build(img, role) {
        const p = profiles[role];
        if (!p || !img.naturalWidth || !img.naturalHeight) return null;
        const scale = p.size / Math.max(img.naturalWidth, img.naturalHeight);
        const w = Math.max(1, Math.round(img.naturalWidth * scale));
        const h = Math.max(1, Math.round(img.naturalHeight * scale));
        const source = document.createElement('canvas');
        source.width = w; source.height = h;
        const read = source.getContext('2d', { willReadFrequently: true });
        read.drawImage(img, 0, 0, w, h);
        const pixels = read.getImageData(0, 0, w, h).data;
        const form = silhouette(pixels, w, h);
        if (form.right < form.left) return null;

        const atlas = document.createElement('canvas');
        atlas.width = w * COLUMNS; atlas.height = h * (LAYERS / COLUMNS);
        const ctx = atlas.getContext('2d');
        const frame = ctx.createImageData(atlas.width, atlas.height);
        const floor = new Float32Array(w * h);
        const roof = new Float32Array(w * h);
        let maxRoof = p.rim;
        const radius = Math.max(2.4, Math.min(form.right - form.left + 1, form.maxY - form.minY + 1) * 0.085);
        for (let y = form.minY; y <= form.maxY; y++) {
            for (let x = form.left; x <= form.right; x++) {
                const i = y * w + x;
                if (!form.distance[i]) continue;
                const spine = (y - (form.top[x] + form.bottom[x]) * 0.5) / Math.max(1, (form.bottom[x] - form.top[x]) * 0.5);
                const longitudinal = (x - form.left) / Math.max(1, form.right - form.left);
                const edge = smooth(0, radius, form.distance[i] / 3);
                const fromHelmet = (y - form.minY) / Math.max(1, form.maxY - form.minY);
                const guide = upperGuide[role];
                const column = guide ? longitudinal * (guide.length - 1) : 0;
                const low = Math.floor(column), high = Math.ceil(column);
                const width = guide ? (guide[low] + (guide[high] - guide[low]) * (column - low)) / 9 : 1;
                const volume = sectionRoof(role, longitudinal, spine, fromHelmet) * (0.73 + 0.27 * width);
                floor[i] = p.rim * (1 - edge);
                roof[i] = p.rim + (p.max - p.rim) * edge * (0.24 + 0.76 * volume);
                maxRoof = Math.max(maxRoof, roof[i]);
            }
        }

        const roofScale = (LAYERS - 1 - RIM) / Math.max(0.01, maxRoof - p.rim);
        // Thin effects and antialiased edges are placed on one plane. Full
        // material occupies its floor-to-roof interval as true slices.
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const i = y * w + x, src = 4 * i;
                const alpha = pixels[src + 3];
                if (!alpha) continue;
                const lo = form.distance[i] ? Math.floor(floor[i] * RIM / p.rim) : RIM;
                const hi = form.distance[i] ? RIM + Math.round((roof[i] - p.rim) * roofScale) : RIM;
                for (let z = lo; z <= hi; z++) {
                    const row = Math.floor(z / COLUMNS) * h + y;
                    const col = (z % COLUMNS) * w + x;
                    const dst = 4 * (row * atlas.width + col);
                    const shade = z === hi ? 1 : 0.62 + 0.29 * z / (LAYERS - 1);
                    for (let channel = 0; channel < 3; channel++) frame.data[dst + channel] = pixels[src + channel] * shade;
                    frame.data[dst + 3] = alpha;
                }
            }
        }
        ctx.putImageData(frame, 0, 0);
        return { atlas, w, h, rim: RIM };
    }

    function schedule() {
        if (scheduled || !queued.length) return;
        scheduled = true;
        const next = () => {
            scheduled = false;
            const job = queued.shift();
            if (atlases.get(job.img) === job) {
                try { job.stack = build(job.img, job.role); }
                catch (_) { job.stack = null; } // Unreadable textures retain the original sprite.
            }
            schedule();
        };
        if ('requestIdleCallback' in window) window.requestIdleCallback(next, { timeout: 200 });
        else window.setTimeout(next, 0);
    }

    function prepare(entry) {
        const enqueue = () => {
            if (atlases.get(entry.img) !== entry) return;
            queued.push(entry);
            schedule();
        };
        if (entry.img.src.split('?')[0].endsWith('/f2_helios_' + entry.role + '.png')) {
            const atlas = new Image();
            atlas.onload = () => {
                if (atlases.get(entry.img) !== entry) return;
                const w = atlas.naturalWidth / COLUMNS;
                const h = atlas.naturalHeight / (LAYERS / COLUMNS);
                if (Number.isInteger(w) && Number.isInteger(h) && Math.max(w, h) === profiles[entry.role].size) {
                    entry.stack = { atlas, w, h, rim: RIM };
                } else enqueue();
            };
            atlas.onerror = enqueue;
            atlas.src = 'assets/stacks/helios_' + entry.role + '.png?v=20261127a246';
        } else enqueue();
    }

    function stackFor(img, role) {
        let entry = atlases.get(img);
        if (entry) atlases.delete(img); // Touch the entry for LRU order.
        else {
            entry = { img, role, stack: null };
            if (atlases.size >= CACHE_LIMIT) atlases.delete(atlases.keys().next().value);
            atlases.set(img, entry);
            prepare(entry);
            return null;
        }
        atlases.set(img, entry);
        return entry.stack;
    }

    function paint(ctx, stack, role, width, height, angle, flipped, screenScale) {
        const { atlas, w, h, rim } = stack;
        const lift = Math.max(width, height) * profiles[role].lift;
        const dx = -Math.sin(angle) * lift / (LAYERS - 1);
        const dy = -Math.cos(angle) * lift / (LAYERS - 1) * (flipped ? -1 : 1);
        const stride = screenScale * lift >= 9 ? 1 : screenScale * lift >= 4 ? 2 : 3;
        for (let z = 0; z < LAYERS; z++) {
            if (z !== rim && z !== LAYERS - 1 && z % stride) continue;
            const alt = z - rim;
            ctx.drawImage(atlas, (z % COLUMNS) * w, Math.floor(z / COLUMNS) * h, w, h,
                -width / 2 + alt * dx, -height / 2 + alt * dy, width, height);
        }
    }

    function draw(ctx, img, role, width, height, angle, flipped, screenScale) {
        if (!profiles[role] || ctx.globalAlpha < 0.98 || Math.max(width, height) * screenScale < 12) return false;
        const stack = stackFor(img, role);
        if (!stack) return false;
        paint(ctx, stack, role, width, height, angle, flipped, screenScale);
        return true;
    }

    return { draw, build, paint, layers: LAYERS };
})();
