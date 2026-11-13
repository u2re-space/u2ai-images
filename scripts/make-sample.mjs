import { encodeRgba } from '../src/image/raster.js';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const dir = process.argv[2];
await mkdir(dir, { recursive: true });
const w = 100;
const h = 80;
const data = Buffer.alloc(w * h * 4);
for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
        const at = (y * w + x) * 4;
        const inside = x > 20 && x < 80 && y > 10 && y < 70;
        data[at] = inside ? 20 : 255;
        data[at + 1] = inside ? 120 : 255;
        data[at + 2] = inside ? 220 : 255;
        data[at + 3] = 255;
    }
}
await writeFile(path.join(dir, 'a.png'), await encodeRgba({ width: w, height: h, data }, { format: 'png' }));
console.log('written', path.join(dir, 'a.png'));
