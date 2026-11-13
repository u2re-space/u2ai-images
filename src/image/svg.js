/**
 * @file src/image/svg.js
 * @module image/svg
 * @purpose The local rasterizer of the SVG documents: ReSVG first, then the SVG side of sharp.
 * @depends @resvg/resvg-js (optional), sharp (optional)
 * @usedBy image/raster
 * @exports isSvgBytes, svgToPng, resvgAvailable
 * @ai.tags svg, resvg, image
 * @ai.hint io
 */

/** Cached module handle. null = not tried yet, false = unavailable, object = the module. */
let cached = null;

/**
 * Load ReSVG once. Returns the `Resvg` constructor or `null` when the native binary is missing.
 * @returns {Promise<Function|null>}
 * @exports
 * @ai.hint io
 */
export async function resvgAvailable() {
    if (cached === null) {
        try {
            const module = await import('@resvg/resvg-js');
            cached = module.Resvg ?? module.default?.Resvg ?? false;
        } catch {
            cached = false;
        }
    }
    return cached || null;
}

/**
 * Is the buffer an SVG document rather than a raster picture?
 *
 * The signature of a raster settles the question before any text scan.
 * @param {Buffer} bytes
 * @returns {boolean}
 * @exports
 * @ai.hint pure
 */
export function isSvgBytes(bytes) {
    if (!bytes?.length) return false;
    if (bytes[0] === 0x89 && bytes[1] === 0x50) return false;
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return false;
    if (bytes.subarray(0, 4).toString('latin1') === 'RIFF') return false;
    if (bytes.subarray(0, 4).toString('latin1') === 'GIF8') return false;
    const head = bytes.subarray(0, 1024).toString('utf8').replace(/^\uFEFF/, '').trimStart();
    return head.startsWith('<') && /<svg[\s>]/i.test(head);
}

/**
 * Render an SVG document into PNG bytes.
 *
 * ReSVG is a dedicated renderer: it keeps the gradients, the masks and the text metrics of the
 * document closer to the source than the SVG side of a raster library. sharp is the second
 * choice, and node-canvas the third.
 * @param {Buffer} bytes
 * @param {{ width?: number|null, height?: number|null }} [options] The frame of the render; one
 *   named side fits that side and keeps the ratio, both sides fit the picture inside the box.
 * @returns {Promise<{ png: Buffer, width: number, height: number }|null>}
 * @exports
 * @ai.hint io
 */
export async function svgToPng(bytes, { width = null, height = null } = {}) {
    const Resvg = await resvgAvailable();
    if (Resvg) {
        const render = (options) => {
            const image = new Resvg(bytes, { background: 'rgba(0,0,0,0)', ...options }).render();
            return { png: Buffer.from(image.asPng()), width: image.width, height: image.height };
        };
        try {
            const base = render({});
            if (width && !height) return render({ fitTo: { mode: 'width', value: Math.max(1, Math.round(width)) } });
            if (height && !width) return render({ fitTo: { mode: 'height', value: Math.max(1, Math.round(height)) } });
            if (!width || !height) return base;
            const scale = Math.min(width / base.width, height / base.height);
            if (scale >= 1) return base;
            return render({ fitTo: { mode: 'zoom', value: scale } });
        } catch {
            // A document ReSVG refuses is still worth a try in the next renderer.
        }
    }
    try {
        const sharp = (await import('sharp')).default;
        const rendered = await sharp(bytes, { density: 144 }).png().toBuffer();
        const meta = await sharp(rendered).metadata();
        return { png: rendered, width: meta.width ?? 0, height: meta.height ?? 0 };
    } catch {
        return null;
    }
}
