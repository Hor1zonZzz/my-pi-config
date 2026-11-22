//! Special non-standard chart layouts:
//! - Horizontal bar chart (`barh`)
//! - Boxplot (`boxplot`)
//! - 2D Heatmap (`heatmap`)
//! - Pie & Donut chart (`pie`, `donut`)

use crate::render::{
    draw_line, fill_circle, fill_rect, format_tick, hex, nice_ticks, stroke_rect, text_hex, Renderer, ThemeColors,
    DEFAULT_PALETTE,
};
use crate::spec::{BoxGroup, ChartSeries, HoverReading, PlotBoxFrac, RenderRequest};
use std::f32::consts::PI;
use tiny_skia::{Color, FillRule, Paint, PathBuilder, Pixmap, Stroke, Transform};

pub struct SpecialRenderOutput {
    pub x_domain: [f64; 2],
    pub y_domain: [f64; 2],
    pub plot_box: PlotBoxFrac,
    pub hover_readings: Option<Vec<HoverReading>>,
}

/// Horizontal bar chart (`style: "barh"`).
pub fn render_barh(
    r: &mut Renderer,
    pixmap: &mut Pixmap,
    req: &RenderRequest,
    series: &ChartSeries,
    theme: &ThemeColors,
    dpr: f32,
) -> SpecialRenderOutput {
    let w = pixmap.width() as f32;
    let h = pixmap.height() as f32;
    let owned_pts: Vec<crate::spec::ChartPoint>;
    let pts: &[crate::spec::ChartPoint] = if let Some(p) = series.points.as_deref() {
        p
    } else if let Some(vals) = series.values.as_deref() {
        owned_pts = vals
            .iter()
            .enumerate()
            .map(|(i, &v)| crate::spec::ChartPoint {
                x: i as f64,
                y: v,
                y_low: None,
                y_high: None,
                r: None,
                label: None,
            })
            .collect();
        &owned_pts
    } else {
        &[]
    };
    let cats = req.spec.categories.as_deref();
    let n = pts.len().max(1);

    let labels: Vec<String> = (0..pts.len())
        .map(|i| {
            pts[i]
                .label
                .clone()
                .or_else(|| cats.and_then(|c| c.get(i).cloned()))
                .unwrap_or_else(|| format_tick(pts[i].x))
        })
        .collect();

    let max_lbl_w = labels
        .iter()
        .map(|l| r.measure_text_width(l, 12.0 * dpr))
        .fold(52.0 * dpr, f32::max)
        .min(w * 0.32);

    let pad_left = max_lbl_w + 22.0 * dpr;
    let pad_right = 56.0 * dpr;
    let pad_top = 12.0 * dpr;
    let pad_bottom = (if req.spec.x_label.is_some() { 40.0 } else { 26.0 }) * dpr;
    let plot_x = pad_left;
    let plot_y = pad_top;
    let plot_w = (w - pad_left - pad_right).max(80.0 * dpr);
    let plot_h = (h - pad_top - pad_bottom).max(60.0 * dpr);

    draw_line(pixmap, plot_x, plot_y, plot_x, plot_y + plot_h, theme.border, 1.0 * dpr, None);
    draw_line(pixmap, plot_x, plot_y + plot_h, plot_x + plot_w, plot_y + plot_h, theme.border, 1.0 * dpr, None);

    let min_v = req
        .spec
        .x_domain
        .map(|d| d[0])
        .unwrap_or_else(|| pts.iter().map(|p| p.y).fold(0.0_f64, f64::min));
    let max_v = req
        .spec
        .x_domain
        .map(|d| d[1])
        .unwrap_or_else(|| pts.iter().map(|p| p.y).fold(0.0_f64, f64::max).max(1e-6) * 1.12);
    let span = (max_v - min_v).max(1e-9);
    let map_x = |v: f64| -> f32 { plot_x + ((v - min_v) / span) as f32 * plot_w };

    for &xv in &nice_ticks(min_v, max_v, 6) {
        let px = map_x(xv);
        if px < plot_x - 1.0 || px > plot_x + plot_w + 1.0 {
            continue;
        }
        draw_line(pixmap, px, plot_y, px, plot_y + plot_h, theme.grid, 0.9 * dpr, None);
        r.draw_text_center(pixmap, &format_tick(xv), px, plot_y + plot_h + 6.0 * dpr, 11.5 * dpr, theme.text_muted);
    }

    let row_h = plot_h / (n as f32);
    let bar_h = (row_h * 0.62).clamp(6.0 * dpr, 34.0 * dpr);
    let base_x = map_x(0.0_f64.clamp(min_v, max_v));
    let bar_color_hex = series.color.as_deref().unwrap_or(DEFAULT_PALETTE[0]);

    let hover_idx: Option<usize> = req.hover_norm_y.and_then(|ny| {
        let py = ny as f32 * h;
        if py >= plot_y && py <= plot_y + plot_h {
            let idx = ((py - plot_y) / row_h).floor() as usize;
            if idx < pts.len() { Some(idx) } else { None }
        } else {
            None
        }
    });

    let mut hover_readings = None;
    for (i, pt) in pts.iter().enumerate() {
        let cy = plot_y + (i as f32 + 0.5) * row_h;
        let by = cy - bar_h * 0.5;
        let x1 = map_x(pt.y).clamp(plot_x, plot_x + plot_w);
        let left = base_x.min(x1);
        let bw = (x1 - base_x).abs().max(2.0 * dpr);
        let is_hover = hover_idx == Some(i);
        let col = if is_hover {
            brighten(hex(bar_color_hex), 1.15)
        } else {
            hex(bar_color_hex)
        };
        if is_hover {
            fill_rect(pixmap, plot_x, plot_y + i as f32 * row_h, plot_w, row_h, Color::from_rgba8(128, 148, 180, 28));
            hover_readings = Some(vec![HoverReading {
                label: labels[i].clone(),
                color: bar_color_hex.to_string(),
                x: i as f64,
                y: pt.y,
                text: Some(format!("{}: {}", labels[i], format_tick(pt.y))),
            }]);
        }
        fill_rect(pixmap, left, by, bw, bar_h, col);
        r.draw_text_right(pixmap, &labels[i], plot_x - 8.0 * dpr, cy - 6.5 * dpr, 12.0 * dpr, theme.text_primary);
        r.draw_text(pixmap, &format_tick(pt.y), left + bw + 6.0 * dpr, cy - 6.0 * dpr, 11.5 * dpr, theme.text_muted, is_hover);
    }

    if let Some(xl) = &req.spec.x_label {
        r.draw_text_center(pixmap, xl, plot_x + plot_w * 0.5, h - 18.0 * dpr, 11.5 * dpr, theme.text_muted);
    }

    SpecialRenderOutput {
        x_domain: [min_v, max_v],
        y_domain: [0.0, n as f64],
        plot_box: PlotBoxFrac {
            left: plot_x as f64 / w as f64,
            right: (plot_x + plot_w) as f64 / w as f64,
            top: plot_y as f64 / h as f64,
            bottom: (plot_y + plot_h) as f64 / h as f64,
        },
        hover_readings,
    }
}

/// Boxplot (`style: "boxplot"`).
pub fn render_boxplot(
    r: &mut Renderer,
    pixmap: &mut Pixmap,
    req: &RenderRequest,
    series: &ChartSeries,
    theme: &ThemeColors,
    dpr: f32,
) -> SpecialRenderOutput {
    let w = pixmap.width() as f32;
    let h = pixmap.height() as f32;
    let groups = series.groups.as_deref().unwrap_or(&[]);

    struct ComputedBox {
        label: String,
        min: f64,
        q1: f64,
        median: f64,
        q3: f64,
        max: f64,
        outliers: Vec<f64>,
        color_hex: String,
    }

    let mut boxes: Vec<ComputedBox> = Vec::new();
    for (i, g) in groups.iter().enumerate() {
        let color_hex = g
            .color
            .clone()
            .or_else(|| series.color.clone())
            .unwrap_or_else(|| DEFAULT_PALETTE[i % DEFAULT_PALETTE.len()].to_string());
        if let Some(vals) = &g.values {
            let mut sorted: Vec<f64> = vals.iter().copied().filter(|v| v.is_finite()).collect();
            if sorted.is_empty() {
                continue;
            }
            sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            let q1 = quantile(&sorted, 0.25);
            let median = quantile(&sorted, 0.50);
            let q3 = quantile(&sorted, 0.75);
            let iqr = q3 - q1;
            let low_fence = q1 - 1.5 * iqr;
            let high_fence = q3 + 1.5 * iqr;
            let mut w_min = q1;
            let mut w_max = q3;
            let mut outliers = Vec::new();
            for &v in &sorted {
                if v < low_fence || v > high_fence {
                    outliers.push(v);
                } else {
                    w_min = w_min.min(v);
                    w_max = w_max.max(v);
                }
            }
            boxes.push(ComputedBox {
                label: g.label.clone(),
                min: w_min,
                q1,
                median,
                q3,
                max: w_max,
                outliers,
                color_hex,
            });
        } else if let (Some(min), Some(q1), Some(med), Some(q3), Some(max)) = (g.min, g.q1, g.median, g.q3, g.max) {
            boxes.push(ComputedBox {
                label: g.label.clone(),
                min,
                q1,
                median: med,
                q3,
                max,
                outliers: Vec::new(),
                color_hex,
            });
        }
    }

    let pad_left = 60.0 * dpr;
    let pad_right = 20.0 * dpr;
    let pad_top = 12.0 * dpr;
    let pad_bottom = 36.0 * dpr;
    let plot_x = pad_left;
    let plot_y = pad_top;
    let plot_w = (w - pad_left - pad_right).max(80.0 * dpr);
    let plot_h = (h - pad_top - pad_bottom).max(60.0 * dpr);

    draw_line(pixmap, plot_x, plot_y, plot_x, plot_y + plot_h, theme.border, 1.0 * dpr, None);
    draw_line(pixmap, plot_x, plot_y + plot_h, plot_x + plot_w, plot_y + plot_h, theme.border, 1.0 * dpr, None);

    let mut y_min = f64::INFINITY;
    let mut y_max = f64::NEG_INFINITY;
    for b in &boxes {
        y_min = y_min.min(b.min);
        y_max = y_max.max(b.max);
        for &o in &b.outliers {
            y_min = y_min.min(o);
            y_max = y_max.max(o);
        }
    }
    let [y_min, y_max] = req.spec.y_domain.unwrap_or_else(|| {
        if !y_min.is_finite() || !y_max.is_finite() {
            [0.0, 1.0]
        } else {
            let pad = (y_max - y_min).max(1e-6) * 0.12;
            [y_min - pad, y_max + pad]
        }
    });
    let map_y = |v: f64| -> f32 { plot_y + ((y_max - v) / (y_max - y_min).max(1e-9)) as f32 * plot_h };

    for &yv in &nice_ticks(y_min, y_max, 5) {
        let py = map_y(yv);
        if py < plot_y - 1.0 || py > plot_y + plot_h + 1.0 {
            continue;
        }
        draw_line(pixmap, plot_x, py, plot_x + plot_w, py, theme.grid, 0.9 * dpr, None);
        r.draw_text_right(pixmap, &format_tick(yv), plot_x - 8.0 * dpr, py - 6.0 * dpr, 11.5 * dpr, theme.text_muted);
    }

    let n = boxes.len().max(1);
    let slot_w = plot_w / n as f32;
    let box_w = (slot_w * 0.45).clamp(14.0 * dpr, 64.0 * dpr);
    let hover_idx: Option<usize> = req.hover_norm_x.and_then(|nx| {
        let px = nx as f32 * w;
        if px >= plot_x && px <= plot_x + plot_w {
            let idx = ((px - plot_x) / slot_w).floor() as usize;
            if idx < boxes.len() { Some(idx) } else { None }
        } else {
            None
        }
    });

    let mut hover_readings = None;
    for (i, b) in boxes.iter().enumerate() {
        let cx = plot_x + (i as f32 + 0.5) * slot_w;
        let col = hex(&b.color_hex);
        let mut fill_col = col;
        fill_col.set_alpha(0.28);

        let y_min_px = map_y(b.min);
        let y_q1_px = map_y(b.q1);
        let y_med_px = map_y(b.median);
        let y_q3_px = map_y(b.q3);
        let y_max_px = map_y(b.max);

        // Whiskers
        draw_line(pixmap, cx, y_max_px, cx, y_q3_px, col, 1.6 * dpr, None);
        draw_line(pixmap, cx, y_q1_px, cx, y_min_px, col, 1.6 * dpr, None);
        draw_line(pixmap, cx - box_w * 0.28, y_max_px, cx + box_w * 0.28, y_max_px, col, 1.7 * dpr, None);
        draw_line(pixmap, cx - box_w * 0.28, y_min_px, cx + box_w * 0.28, y_min_px, col, 1.7 * dpr, None);

        // IQR Box
        let bx = cx - box_w * 0.5;
        let bh = (y_q1_px - y_q3_px).abs().max(2.0 * dpr);
        fill_rect(pixmap, bx, y_q3_px, box_w, bh, fill_col);
        stroke_rect(pixmap, bx, y_q3_px, box_w, bh, col, 1.8 * dpr);

        // Median line
        draw_line(pixmap, bx, y_med_px, bx + box_w, y_med_px, col, 2.8 * dpr, None);

        // Outliers
        for &o in &b.outliers {
            fill_circle(pixmap, cx, map_y(o), 3.6 * dpr, col);
        }

        r.draw_text_center(pixmap, &b.label, cx, plot_y + plot_h + 7.0 * dpr, 12.0 * dpr, theme.text_primary);

        if hover_idx == Some(i) {
            hover_readings = Some(vec![HoverReading {
                label: b.label.clone(),
                color: b.color_hex.clone(),
                x: i as f64,
                y: b.median,
                text: Some(format!(
                    "{}: min={} Q1={} med={} Q3={} max={}",
                    b.label,
                    format_tick(b.min),
                    format_tick(b.q1),
                    format_tick(b.median),
                    format_tick(b.q3),
                    format_tick(b.max)
                )),
            }]);
        }
    }

    SpecialRenderOutput {
        x_domain: [0.0, n as f64],
        y_domain: [y_min, y_max],
        plot_box: PlotBoxFrac {
            left: plot_x as f64 / w as f64,
            right: (plot_x + plot_w) as f64 / w as f64,
            top: plot_y as f64 / h as f64,
            bottom: (plot_y + plot_h) as f64 / h as f64,
        },
        hover_readings,
    }
}

/// 2D Heatmap (`style: "heatmap"`).
pub fn render_heatmap(
    r: &mut Renderer,
    pixmap: &mut Pixmap,
    req: &RenderRequest,
    series: &ChartSeries,
    theme: &ThemeColors,
    dpr: f32,
) -> SpecialRenderOutput {
    let w = pixmap.width() as f32;
    let h = pixmap.height() as f32;
    let matrix = series.matrix.as_deref().unwrap_or(&[]);
    let rows = matrix.len().max(1);
    let cols = matrix.first().map(|r| r.len()).unwrap_or(1).max(1);

    let pad_left = 70.0 * dpr;
    let pad_right = 64.0 * dpr;
    let pad_top = 12.0 * dpr;
    let pad_bottom = 32.0 * dpr;
    let plot_x = pad_left;
    let plot_y = pad_top;
    let plot_w = (w - pad_left - pad_right).max(80.0 * dpr);
    let plot_h = (h - pad_top - pad_bottom).max(60.0 * dpr);

    let mut vmin = f64::INFINITY;
    let mut vmax = f64::NEG_INFINITY;
    for row in matrix {
        for &v in row {
            if v.is_finite() {
                vmin = vmin.min(v);
                vmax = vmax.max(v);
            }
        }
    }
    if !vmin.is_finite() || !vmax.is_finite() || (vmax - vmin).abs() < 1e-12 {
        vmin = 0.0;
        vmax = 1.0;
    }

    let cw = plot_w / cols as f32;
    let ch = plot_h / rows as f32;

    let hover_cell: Option<(usize, usize)> = match (req.hover_norm_x, req.hover_norm_y) {
        (Some(nx), Some(ny)) => {
            let px = nx as f32 * w;
            let py = ny as f32 * h;
            if px >= plot_x && px <= plot_x + plot_w && py >= plot_y && py <= plot_y + plot_h {
                let c = ((px - plot_x) / cw).floor() as usize;
                let r_idx = ((py - plot_y) / ch).floor() as usize;
                if r_idx < rows && c < cols {
                    Some((r_idx, c))
                } else {
                    None
                }
            } else {
                None
            }
        }
        _ => None,
    };

    let mut hover_readings = None;
    for (ri, row) in matrix.iter().enumerate() {
        for (ci, &v) in row.iter().enumerate() {
            let t = ((v - vmin) / (vmax - vmin)).clamp(0.0, 1.0);
            let col = viridis_color(t);
            let cx = plot_x + ci as f32 * cw;
            let cy = plot_y + ri as f32 * ch;
            fill_rect(pixmap, cx, cy, cw + 0.5, ch + 0.5, col);
            if cw >= 36.0 * dpr && ch >= 20.0 * dpr {
                let txt_col = if t > 0.55 { text_hex("#111827") } else { text_hex("#f8fafc") };
                r.draw_text_center(pixmap, &format_tick(v), cx + cw * 0.5, cy + ch * 0.5 - 6.0 * dpr, 11.0 * dpr, txt_col);
            }
            if hover_cell == Some((ri, ci)) {
                stroke_rect(pixmap, cx + dpr, cy + dpr, (cw - 2.0 * dpr).max(2.0), (ch - 2.0 * dpr).max(2.0), hex("#ffffff"), 2.0 * dpr);
                let xl = series
                    .x_labels
                    .as_ref()
                    .and_then(|v| v.get(ci).cloned())
                    .unwrap_or_else(|| format!("C{ci}"));
                let yl = series
                    .y_labels
                    .as_ref()
                    .and_then(|v| v.get(ri).cloned())
                    .unwrap_or_else(|| format!("R{ri}"));
                hover_readings = Some(vec![HoverReading {
                    label: format!("{yl} × {xl}"),
                    color: "#8bd5ca".to_string(),
                    x: ci as f64,
                    y: v,
                    text: Some(format!("[{yl}, {xl}] = {:.3}", v)),
                }]);
            }
        }
    }
    stroke_rect(pixmap, plot_x, plot_y, plot_w, plot_h, theme.border, 1.0 * dpr);

    // Axis labels
    if let Some(xls) = &series.x_labels {
        for (ci, lbl) in xls.iter().take(cols).enumerate() {
            r.draw_text_center(pixmap, lbl, plot_x + (ci as f32 + 0.5) * cw, plot_y + plot_h + 6.0 * dpr, 11.0 * dpr, theme.text_muted);
        }
    }
    if let Some(yls) = &series.y_labels {
        for (ri, lbl) in yls.iter().take(rows).enumerate() {
            r.draw_text_right(pixmap, lbl, plot_x - 8.0 * dpr, plot_y + (ri as f32 + 0.5) * ch - 6.0 * dpr, 11.0 * dpr, theme.text_muted);
        }
    }

    // Colorbar on the right
    let cb_x = plot_x + plot_w + 14.0 * dpr;
    let cb_w = 12.0 * dpr;
    let steps = 40;
    let sh = plot_h / steps as f32;
    for i in 0..steps {
        let t = 1.0 - (i as f64 / (steps - 1) as f64);
        fill_rect(pixmap, cb_x, plot_y + i as f32 * sh, cb_w, sh + 0.8, viridis_color(t));
    }
    stroke_rect(pixmap, cb_x, plot_y, cb_w, plot_h, theme.border, 0.8 * dpr);
    r.draw_text(pixmap, &format_tick(vmax), cb_x + cb_w + 5.0 * dpr, plot_y - 2.0 * dpr, 10.5 * dpr, theme.text_muted, false);
    r.draw_text(pixmap, &format_tick(vmin), cb_x + cb_w + 5.0 * dpr, plot_y + plot_h - 11.0 * dpr, 10.5 * dpr, theme.text_muted, false);

    SpecialRenderOutput {
        x_domain: [0.0, cols as f64],
        y_domain: [vmin, vmax],
        plot_box: PlotBoxFrac {
            left: plot_x as f64 / w as f64,
            right: (plot_x + plot_w) as f64 / w as f64,
            top: plot_y as f64 / h as f64,
            bottom: (plot_y + plot_h) as f64 / h as f64,
        },
        hover_readings,
    }
}

/// Pie / Donut chart (`style: "pie"` | `"donut"`).
pub fn render_pie(
    r: &mut Renderer,
    pixmap: &mut Pixmap,
    req: &RenderRequest,
    series: &ChartSeries,
    theme: &ThemeColors,
    is_donut: bool,
    dpr: f32,
) -> SpecialRenderOutput {
    let w = pixmap.width() as f32;
    let h = pixmap.height() as f32;
    let slices = series.slices.as_deref().unwrap_or(&[]);
    let total: f64 = slices.iter().map(|s| s.value.max(0.0)).sum::<f64>().max(1e-9);

    let pad_top = 12.0 * dpr;
    let avail_h = (h - pad_top - 14.0 * dpr).max(80.0 * dpr);
    let radius = (avail_h * 0.44).min(w * 0.24).max(36.0 * dpr);
    let cx = (w * 0.34).max(radius + 28.0 * dpr);
    let cy = pad_top + avail_h * 0.5;
    let inner_r = if is_donut { radius * 0.54 } else { 0.0 };

    // Determine hovered slice from polar angle
    let hover_angle: Option<f32> = match (req.hover_norm_x, req.hover_norm_y) {
        (Some(nx), Some(ny)) => {
            let dx = nx as f32 * w - cx;
            let dy = ny as f32 * h - cy;
            let dist = (dx * dx + dy * dy).sqrt();
            if dist >= inner_r && dist <= radius * 1.08 {
                let mut ang = dy.atan2(dx) + PI * 0.5;
                if ang < 0.0 {
                    ang += 2.0 * PI;
                }
                Some(ang)
            } else {
                None
            }
        }
        _ => None,
    };

    let mut start_angle = -PI * 0.5;
    let mut accum_angle = 0.0_f32;
    let mut hover_readings = None;

    let legend_x = (cx + radius + 36.0 * dpr).min(w - 160.0 * dpr);
    let legend_start_y = (cy - (slices.len() as f32 * 24.0 * dpr) * 0.5).max(pad_top + 6.0 * dpr);

    for (i, s) in slices.iter().enumerate() {
        let frac = (s.value.max(0.0) / total) as f32;
        let sweep = frac * 2.0 * PI;
        let color_hex = s
            .color
            .as_deref()
            .unwrap_or(DEFAULT_PALETTE[i % DEFAULT_PALETTE.len()]);
        let is_hover = hover_angle.map_or(false, |a| a >= accum_angle && a <= accum_angle + sweep);
        let r_out = if is_hover { radius * 1.05 } else { radius };

        draw_sector(pixmap, cx, cy, inner_r, r_out, start_angle, start_angle + sweep, hex(color_hex), theme.bg);

        // Legend row
        let ly = legend_start_y + i as f32 * 24.0 * dpr;
        if ly < h - 16.0 * dpr {
            fill_rect(pixmap, legend_x, ly + 3.0 * dpr, 11.0 * dpr, 11.0 * dpr, hex(color_hex));
            let label = format!("{}  ({:.1}% · {})", s.label, frac * 100.0, format_tick(s.value));
            r.draw_text(
                pixmap,
                &label,
                legend_x + 17.0 * dpr,
                ly,
                12.0 * dpr,
                if is_hover { theme.text_primary } else { theme.text_muted },
                is_hover,
            );
        }

        if is_hover {
            hover_readings = Some(vec![HoverReading {
                label: s.label.clone(),
                color: color_hex.to_string(),
                x: i as f64,
                y: s.value,
                text: Some(format!("{}: {} ({:.1}%)", s.label, format_tick(s.value), frac * 100.0)),
            }]);
        }

        start_angle += sweep;
        accum_angle += sweep;
    }

    if is_donut {
        let center_txt = format_tick(total);
        r.draw_text_center(pixmap, &center_txt, cx, cy - 8.0 * dpr, 15.0 * dpr, theme.text_primary);
    }

    SpecialRenderOutput {
        x_domain: [0.0, 1.0],
        y_domain: [0.0, total],
        plot_box: PlotBoxFrac {
            left: (cx - radius) as f64 / w as f64,
            right: (cx + radius) as f64 / w as f64,
            top: (cy - radius) as f64 / h as f64,
            bottom: (cy + radius) as f64 / h as f64,
        },
        hover_readings,
    }
}

fn draw_sector(
    pixmap: &mut Pixmap,
    cx: f32,
    cy: f32,
    r_in: f32,
    r_out: f32,
    a0: f32,
    a1: f32,
    fill: Color,
    stroke_col: Color,
) {
    let steps = ((a1 - a0).abs() * 24.0).ceil().max(6.0) as usize;
    let mut pb = PathBuilder::new();
    for i in 0..=steps {
        let a = a0 + (a1 - a0) * (i as f32 / steps as f32);
        let x = cx + r_out * a.cos();
        let y = cy + r_out * a.sin();
        if i == 0 {
            pb.move_to(x, y);
        } else {
            pb.line_to(x, y);
        }
    }
    if r_in > 0.5 {
        for i in (0..=steps).rev() {
            let a = a0 + (a1 - a0) * (i as f32 / steps as f32);
            pb.line_to(cx + r_in * a.cos(), cy + r_in * a.sin());
        }
    } else {
        pb.line_to(cx, cy);
    }
    pb.close();
    if let Some(path) = pb.finish() {
        let mut paint = Paint::default();
        paint.set_color(fill);
        paint.anti_alias = true;
        pixmap.fill_path(&path, &paint, FillRule::Winding, Transform::identity(), None);
        let mut sp = Paint::default();
        sp.set_color(stroke_col);
        sp.anti_alias = true;
        pixmap.stroke_path(&path, &sp, &Stroke { width: 1.5, ..Stroke::default() }, Transform::identity(), None);
    }
}

fn quantile(sorted: &[f64], q: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let idx = q * (sorted.len() - 1) as f64;
    let lo = idx.floor() as usize;
    let hi = idx.ceil() as usize;
    if lo == hi {
        sorted[lo]
    } else {
        sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo as f64)
    }
}

fn brighten(c: Color, factor: f32) -> Color {
    Color::from_rgba(
        (c.red() * factor).min(1.0),
        (c.green() * factor).min(1.0),
        (c.blue() * factor).min(1.0),
        c.alpha(),
    )
    .unwrap_or(c)
}

fn viridis_color(t: f64) -> Color {
    // Smooth 5-stop Viridis approximation
    const STOPS: &[(f64, u8, u8, u8)] = &[
        (0.00, 68, 1, 84),
        (0.25, 59, 82, 139),
        (0.50, 33, 145, 140),
        (0.75, 94, 201, 98),
        (1.00, 253, 231, 37),
    ];
    let t = t.clamp(0.0, 1.0);
    for w in STOPS.windows(2) {
        let (t0, r0, g0, b0) = w[0];
        let (t1, r1, g1, b1) = w[1];
        if t >= t0 && t <= t1 {
            let f = (t - t0) / (t1 - t0);
            let lerp = |a: u8, b: u8| -> u8 { (a as f64 + (b as f64 - a as f64) * f).round() as u8 };
            return Color::from_rgba8(lerp(r0, r1), lerp(g0, g1), lerp(b0, b1), 255);
        }
    }
    Color::from_rgba8(253, 231, 37, 255)
}
