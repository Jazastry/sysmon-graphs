// Smooth area/line chart drawn with a Cairo context.
import Cairo from 'cairo';

export function hexToRgb(hex) {
    const n = parseInt(hex.replace('#', ''), 16);
    return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
}

// Mix a '#rrggbb' colour with white (f = 0..1) and return '#rrggbb'.
export function lighten(hex, f = 0.55) {
    const [r, g, b] = hexToRgb(hex).map(v => Math.round((v + (1 - v) * f) * 255));
    return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
}

function roundedRect(cr, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    cr.newSubPath();
    cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI);
    cr.closePath();
}

// Catmull-Rom spline through pts, converted to cubic Beziers. Control points are clamped
// vertically between the two end points so the curve never overshoots (no dips below 0).
function curvePath(cr, pts) {
    cr.moveTo(pts[0].x, pts[0].y);
    for (let i = 0; i < pts.length - 1; i++) {
        const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
        const lo = Math.min(p1.y, p2.y), hi = Math.max(p1.y, p2.y);
        const c1y = Math.min(hi, Math.max(lo, p1.y + (p2.y - p0.y) / 6));
        const c2y = Math.min(hi, Math.max(lo, p2.y - (p3.y - p1.y) / 6));
        cr.curveTo(p1.x + (p2.x - p0.x) / 6, c1y, p2.x - (p3.x - p1.x) / 6, c2y, p2.x, p2.y);
    }
}

/**
 * layers: [{values:number[], color:'#rrggbb', fill:bool=true, width:number=1.3}]
 * opts:   {lo, hi, frac (0..1 scroll phase), points (samples across the width), radius, track, grid}
 */
export function drawChart(cr, w, h, layers, opts = {}) {
    const {lo = 0, hi = 100, frac = 1, points = 40, radius = 4, track = true, grid = false} = opts;
    const dx = w / (points - 1);
    const pad = 1.5;
    const span = Math.max(1e-9, hi - lo);

    cr.save();
    roundedRect(cr, 0, 0, w, h, radius);
    if (track) {
        cr.setSourceRGBA(1, 1, 1, 0.07);
        cr.fillPreserve();
    }
    cr.clip();
    cr.newPath();

    if (grid) {
        cr.setLineWidth(1);
        cr.setSourceRGBA(1, 1, 1, 0.08);
        for (const f of [0.25, 0.5, 0.75]) {
            const y = Math.round(h - f * h) + 0.5;
            cr.moveTo(0, y);
            cr.lineTo(w, y);
            cr.stroke();
        }
    }

    for (const layer of layers) {
        const vals = layer.values;
        const n = vals.length;
        if (n < 2) continue;
        const [r, g, b] = hexToRgb(layer.color);
        const pts = vals.map((v, i) => ({
            x: w + (i - (n - 1)) * dx + dx * (1 - frac),
            y: h - pad - Math.min(1, Math.max(0, (v - lo) / span)) * (h - 2 * pad),
        }));

        if (layer.fill !== false) {
            cr.save();
            curvePath(cr, pts);
            cr.lineTo(pts[n - 1].x, h);
            cr.lineTo(pts[0].x, h);
            cr.closePath();
            cr.clip();
            // vertical fade: strong at the line, transparent at the bottom
            const grad = new Cairo.LinearGradient(0, 0, 0, h);
            grad.addColorStopRGBA(0, r, g, b, 0.60);
            grad.addColorStopRGBA(1, r, g, b, 0.06);
            cr.setSource(grad);
            cr.paint();
            cr.restore();
        }

        // soft glow + crisp line
        cr.setLineJoin(1);
        cr.setLineCap(1);
        curvePath(cr, pts);
        cr.setSourceRGBA(r, g, b, 0.16);
        cr.setLineWidth((layer.width || 1.3) + 1.6);
        cr.strokePreserve();
        cr.setSourceRGBA(r, g, b, 1);
        cr.setLineWidth(layer.width || 1.3);
        cr.stroke();
    }
    cr.restore();
}
