use crate::expr::{parse_expr, Expr};
use crate::render_special::{render_barh, render_boxplot, render_grid, render_heatmap, render_pie};
use crate::spec::{AxisTick, ChartSeries, HoverReading, PlotBoxFrac, RenderRequest, RenderResponse, ThemePalette};
use base64::Engine as _;
use cosmic_text::{Attrs, Buffer, Color as TextColor, Family, FontSystem, Metrics, Shaping, SwashCache};
use std::collections::{HashMap, HashSet};
use std::time::Instant;
use tiny_skia::{Color, FillRule, LineCap, LineJoin, Paint, PathBuilder, Pixmap, Rect, Stroke, StrokeDash, Transform};

pub const DEFAULT_PALETTE: &[&str] = &[
    "#0f766e", "#4F8CFF", "#c6a0f6", "#38a169", "#ed8936", "#e53e3e", "#d69e2e", "#d53f8c",
];

pub struct ThemeColors {
    pub bg: Color,
    pub plot_bg: Color,
    pub border: Color,
    pub grid: Color,
    pub zero_axis: Color,
    pub text_primary: TextColor,
    pub text_muted: TextColor,
    pub accent: Color,
    pub crosshair: Color,
    pub tooltip_bg: Color,
    pub tooltip_border: Color,
}

impl ThemeColors {
    fn dark() -> Self {
        Self {
            bg: Color::TRANSPARENT,
            plot_bg: Color::TRANSPARENT,
            border: Color::from_rgba8(148, 163, 184, 52),
            grid: Color::from_rgba8(148, 163, 184, 34),
            zero_axis: Color::from_rgba8(148, 163, 184, 96),
            text_primary: text_hex("#e8edf7"),
            text_muted: text_hex("#9aa4ba"),
            accent: hex("#8bd5ca"),
            crosshair: Color::from_rgba8(148, 163, 184, 150),
            tooltip_bg: Color::from_rgba8(16, 20, 28, 224),
            tooltip_border: Color::from_rgba8(148, 163, 184, 90),
        }
    }

    fn light() -> Self {
        Self {
            bg: Color::TRANSPARENT,
            plot_bg: Color::TRANSPARENT,
            border: Color::from_rgba8(100, 116, 139, 58),
            grid: Color::from_rgba8(100, 116, 139, 34),
            zero_axis: Color::from_rgba8(100, 116, 139, 105),
            text_primary: text_hex("#1c2433"),
            text_muted: text_hex("#5a6578"),
            accent: hex("#0f766e"),
            crosshair: Color::from_rgba8(71, 85, 105, 150),
            tooltip_bg: Color::from_rgba8(255, 255, 255, 232),
            tooltip_border: Color::from_rgba8(100, 116, 139, 85),
        }
    }

    fn with_palette(mut self, palette: Option<&ThemePalette>, _is_light: bool) -> Self {
        let Some(p) = palette else { return self };
        // Keep bg & plot_bg transparent so the chart blends seamlessly into the native terminal background.
        if let Some(tp) = &p.text_primary {
            self.text_primary = text_hex(tp);
        }
        if let Some(tm) = &p.text_muted {
            self.text_muted = text_hex(tm);
        }
        if let Some(ac) = &p.accent {
            self.accent = hex(ac);
        }
        self
    }
}

pub fn parse_hex_rgb(s: &str) -> (u8, u8, u8) {
    let clean = s.trim().trim_start_matches('#');
    if clean.len() == 6 {
        if let Ok(v) = u32::from_str_radix(clean, 16) {
            return (((v >> 16) & 0xFF) as u8, ((v >> 8) & 0xFF) as u8, (v & 0xFF) as u8);
        }
    }
    (139, 213, 202)
}

pub fn hex(s: &str) -> Color {
    let (r, g, b) = parse_hex_rgb(s);
    Color::from_rgba8(r, g, b, 255)
}

pub fn text_hex(s: &str) -> TextColor {
    let (r, g, b) = parse_hex_rgb(s);
    TextColor::rgb(r, g, b)
}

pub struct Renderer {
    font_system: Option<FontSystem>,
    swash_cache: SwashCache,
}

impl Renderer {
    pub fn new() -> Self {
        // Lazy-init FontSystem so native-axis charts (zero rasterized text) have ~0ms cold start!
        Self {
            font_system: None,
            swash_cache: SwashCache::new(),
        }
    }

    fn font_system(&mut self) -> &mut FontSystem {
        self.font_system.get_or_insert_with(FontSystem::new)
    }

    pub fn render(&mut self, req: &RenderRequest) -> RenderResponse {
        let t0 = Instant::now();
        let w = req.width_px.clamp(240, 2400);
        let h = req.height_px.clamp(140, 1200);
        let dpr = req.dpr.unwrap_or_else(|| (w as f32 / 900.0).clamp(1.0, 2.2)).clamp(1.0, 3.0);
        let is_light = req.theme.as_deref() == Some("light");
        let theme = (if is_light {
            ThemeColors::light()
        } else {
            ThemeColors::dark()
        })
        .with_palette(req.palette.as_ref(), is_light);

        let mut pixmap = match Pixmap::new(w, h) {
            Some(p) => p,
            None => {
                return RenderResponse {
                    req_id: req.req_id,
                    ok: false,
                    error: Some("failed to allocate pixmap".to_string()),
                    png_base64: None,
                    width_px: w,
                    height_px: h,
                    x_domain: [0.0, 1.0],
                    y_domain: [0.0, 1.0],
                    plot_box: PlotBoxFrac { left: 0.0, right: 1.0, top: 0.0, bottom: 1.0 },
                    native_axes_used: false,
                    x_ticks: None,
                    y_ticks: None,
                    hover_readings: None,
                    render_ms: 0.0,
                    draw_ms: 0.0,
                    encode_ms: 0.0,
                };
            }
        };
        pixmap.fill(Color::TRANSPARENT);

        // Title, subtitle, and legend are rendered natively in the terminal card header for crisp vector typography.
        // Dispatch multi-subplot grid if subplots are provided
        if let Some(subplots) = &req.spec.subplots {
            if !subplots.is_empty() {
                let out = render_grid(self, &mut pixmap, req, subplots, &theme, dpr);
                return self.finish(req.req_id, &pixmap, out.x_domain, out.y_domain, out.plot_box, false, None, None, out.hover_readings, t0);
            }
        }

        // Dispatch special standalone chart types if primary series uses them:
        if let Some(first) = req.spec.series.first() {
            match first.style.as_deref() {
                Some("barh") => {
                    let out = render_barh(self, &mut pixmap, req, first, &theme, dpr);
                    return self.finish(req.req_id, &pixmap, out.x_domain, out.y_domain, out.plot_box, false, None, None, out.hover_readings, t0);
                }
                Some("boxplot") => {
                    let out = render_boxplot(self, &mut pixmap, req, first, &theme, dpr);
                    return self.finish(req.req_id, &pixmap, out.x_domain, out.y_domain, out.plot_box, false, None, None, out.hover_readings, t0);
                }
                Some("heatmap") => {
                    let out = render_heatmap(self, &mut pixmap, req, first, &theme, dpr);
                    return self.finish(req.req_id, &pixmap, out.x_domain, out.y_domain, out.plot_box, false, None, None, out.hover_readings, t0);
                }
                Some("pie") => {
                    let out = render_pie(self, &mut pixmap, req, first, &theme, false, dpr);
                    return self.finish(req.req_id, &pixmap, out.x_domain, out.y_domain, out.plot_box, false, None, None, out.hover_readings, t0);
                }
                Some("donut") => {
                    let out = render_pie(self, &mut pixmap, req, first, &theme, true, dpr);
                    return self.finish(req.req_id, &pixmap, out.x_domain, out.y_domain, out.plot_box, false, None, None, out.hover_readings, t0);
                }
                _ => {}
            }
        }

        // Standard Cartesian chart (solid, dashed, area, step, scatter, bar, band, hist + dual Y-axis + categories + dates)
        self.render_cartesian(req, &mut pixmap, &theme, dpr, t0)
    }

    fn finish(
        &self,
        req_id: u64,
        pixmap: &Pixmap,
        x_domain: [f64; 2],
        y_domain: [f64; 2],
        plot_box: PlotBoxFrac,
        native_axes_used: bool,
        x_ticks: Option<Vec<AxisTick>>,
        y_ticks: Option<Vec<AxisTick>>,
        hover_readings: Option<Vec<HoverReading>>,
        t0: Instant,
    ) -> RenderResponse {
        let draw_ms = t0.elapsed().as_secs_f64() * 1000.0;
        let t_enc = Instant::now();
        let png_bytes = encode_fast_png(pixmap);
        let png_base64 = base64::engine::general_purpose::STANDARD.encode(&png_bytes);
        let encode_ms = t_enc.elapsed().as_secs_f64() * 1000.0;
        RenderResponse {
            req_id,
            ok: true,
            error: None,
            png_base64: Some(png_base64),
            width_px: pixmap.width(),
            height_px: pixmap.height(),
            x_domain,
            y_domain,
            plot_box,
            native_axes_used,
            x_ticks,
            y_ticks,
            hover_readings,
            render_ms: t0.elapsed().as_secs_f64() * 1000.0,
            draw_ms,
            encode_ms,
        }
    }

    fn render_cartesian(
        &mut self,
        req: &RenderRequest,
        pixmap: &mut Pixmap,
        theme: &ThemeColors,
        dpr: f32,
        t0: Instant,
    ) -> RenderResponse {
        let w = pixmap.width();
        let h = pixmap.height();

        // Build variable environment
        let mut vars: HashMap<String, f64> = HashMap::new();
        if let Some(params) = &req.spec.params {
            for (k, v) in params {
                vars.insert(k.clone(), *v);
            }
        }
        if let Some(controls) = &req.spec.controls {
            for c in controls {
                vars.insert(c.id.clone(), c.value);
            }
        }
        for (k, v) in &req.control_values {
            vars.insert(k.clone(), *v);
        }

        let hidden: HashSet<&str> = req.hidden_series.iter().map(|s| s.as_str()).collect();
        let samples = req.spec.samples.unwrap_or(280).clamp(16, 2000);
        let categories = req.spec.categories.as_deref();
        let is_categorical = categories.is_some() || req.spec.x_type.as_deref() == Some("category");
        let is_date = req.spec.x_type.as_deref() == Some("date");
        let has_right_axis = req.spec.series.iter().any(|s| s.y_axis.as_deref() == Some("right"))
            || req.spec.y2_label.is_some()
            || req.spec.y2_domain.is_some();

        // Determine X domain
        let base_x_domain = req.view_x_domain.or(req.spec.x_domain).unwrap_or_else(|| {
            if let Some(cats) = categories {
                return [-0.5, (cats.len().max(1) as f64) - 0.5];
            }
            let mut min_x = f64::INFINITY;
            let mut max_x = f64::NEG_INFINITY;
            for s in &req.spec.series {
                if let Some(pts) = &s.points {
                    for p in pts {
                        if p.x.is_finite() {
                            min_x = min_x.min(p.x);
                            max_x = max_x.max(p.x);
                        }
                    }
                }
                if s.style.as_deref() == Some("hist") {
                    if let Some(vals) = &s.values {
                        for &v in vals {
                            if v.is_finite() {
                                min_x = min_x.min(v);
                                max_x = max_x.max(v);
                            }
                        }
                    }
                }
            }
            if min_x.is_finite() && max_x.is_finite() && (max_x - min_x).abs() > 1e-12 {
                let has_bar = req.spec.series.iter().any(|s| s.style.as_deref() == Some("bar"));
                if has_bar {
                    let pad = ((max_x - min_x) * 0.08).max(0.5);
                    [min_x - pad, max_x + pad]
                } else {
                    [min_x, max_x]
                }
            } else {
                [0.0, 12.0]
            }
        });
        let x_min = base_x_domain[0];
        let x_max = if (base_x_domain[1] - x_min).abs() < 1e-12 {
            x_min + 1.0
        } else {
            base_x_domain[1]
        };

        struct ResolvedPoint {
            x: f64,
            y: f64,
            yerr: Option<f64>,
            y_low: Option<f64>,
            y_high: Option<f64>,
            r: Option<f32>,
        }

        struct ResolvedSeries<'a> {
            spec: &'a ChartSeries,
            color_hex: String,
            is_right: bool,
            points: Vec<ResolvedPoint>,
            parsed_expr: Option<Expr>,
            hist_bin_width: Option<f64>,
        }

        let mut resolved: Vec<ResolvedSeries> = Vec::new();
        for (idx, s) in req.spec.series.iter().enumerate() {
            if hidden.contains(s.id.as_str()) {
                continue;
            }
            let color_hex = s
                .color
                .clone()
                .unwrap_or_else(|| DEFAULT_PALETTE[idx % DEFAULT_PALETTE.len()].to_string());
            let is_right = s.y_axis.as_deref() == Some("right");
            let style = s.style.as_deref().unwrap_or("solid");

            let mut parsed_expr = None;
            let mut hist_bin_width = None;
            let points: Vec<ResolvedPoint> = if style == "hist" {
                let vals: Vec<f64> = s
                    .values
                    .as_deref()
                    .unwrap_or(&[])
                    .iter()
                    .copied()
                    .filter(|v| v.is_finite())
                    .collect();
                let bins = vars
                    .get("bins")
                    .map(|v| v.round() as usize)
                    .or(s.bins)
                    .unwrap_or(16)
                    .clamp(3, 80);
                if vals.is_empty() {
                    Vec::new()
                } else {
                    let lo = x_min;
                    let hi = x_max;
                    let bw = ((hi - lo) / bins as f64).max(1e-9);
                    hist_bin_width = Some(bw);
                    let mut counts = vec![0usize; bins];
                    for v in vals {
                        if v >= lo && v <= hi {
                            let mut b = ((v - lo) / bw).floor() as usize;
                            if b >= bins {
                                b = bins - 1;
                            }
                            counts[b] += 1;
                        }
                    }
                    counts
                        .into_iter()
                        .enumerate()
                        .map(|(i, c)| ResolvedPoint {
                            x: lo + (i as f64 + 0.5) * bw,
                            y: c as f64,
                            yerr: None,
                            y_low: None,
                            y_high: None,
                            r: None,
                        })
                        .collect()
                }
            } else if style == "band" && s.formula_low.is_some() && s.formula_high.is_some() {
                let e_lo = parse_expr(s.formula_low.as_deref().unwrap_or("")).ok();
                let e_hi = parse_expr(s.formula_high.as_deref().unwrap_or("")).ok();
                if let (Some(elo), Some(ehi)) = (e_lo, e_hi) {
                    let mut pts = Vec::with_capacity(samples);
                    let mut lv = vars.clone();
                    for i in 0..samples {
                        let x = x_min + (x_max - x_min) * (i as f64) / ((samples - 1) as f64);
                        lv.insert("x".to_string(), x);
                        lv.insert("t".to_string(), x);
                        let yl = elo.eval(&lv);
                        let yh = ehi.eval(&lv);
                        if yl.is_finite() && yh.is_finite() {
                            pts.push(ResolvedPoint {
                                x,
                                y: (yl + yh) * 0.5,
                                yerr: None,
                                y_low: Some(yl),
                                y_high: Some(yh),
                                r: None,
                            });
                        }
                    }
                    pts
                } else {
                    Vec::new()
                }
            } else if let Some(formula) = &s.formula {
                if let Ok(expr) = parse_expr(formula) {
                    let mut pts = Vec::with_capacity(samples);
                    let mut lv = vars.clone();
                    for i in 0..samples {
                        let x = x_min + (x_max - x_min) * (i as f64) / ((samples - 1) as f64);
                        lv.insert("x".to_string(), x);
                        lv.insert("t".to_string(), x);
                        let y = expr.eval(&lv);
                        if y.is_finite() {
                            pts.push(ResolvedPoint { x, y, yerr: None, y_low: None, y_high: None, r: None });
                        }
                    }
                    parsed_expr = Some(expr);
                    pts
                } else {
                    Vec::new()
                }
            } else if let Some(pts) = &s.points {
                pts.iter()
                    .filter(|p| p.x.is_finite() && p.y.is_finite())
                    .map(|p| ResolvedPoint {
                        x: p.x,
                        y: p.y,
                        yerr: p.yerr,
                        y_low: p.y_low,
                        y_high: p.y_high,
                        r: p.r,
                    })
                    .collect()
            } else if let Some(vals) = &s.values {
                // Allow shorthand `values: [24, 36, 30, ...]` for bar/line/area/step/scatter (especially with categories)
                vals.iter()
                    .enumerate()
                    .filter(|(_, v)| v.is_finite())
                    .map(|(i, &v)| ResolvedPoint {
                        x: i as f64,
                        y: v,
                        yerr: None,
                        y_low: None,
                        y_high: None,
                        r: None,
                    })
                    .collect()
            } else {
                Vec::new()
            };

            resolved.push(ResolvedSeries {
                spec: s,
                color_hex,
                is_right,
                points,
                parsed_expr,
                hist_bin_width,
            });
        }

        // Compute left & right Y domains
        let compute_y_domain = |right: bool, override_dom: Option<[f64; 2]>| -> [f64; 2] {
            if let Some(d) = override_dom {
                return d;
            }
            let mut min_y = f64::INFINITY;
            let mut max_y = f64::NEG_INFINITY;
            let mut has_bar_or_hist = false;
            for r in &resolved {
                if r.is_right != right {
                    continue;
                }
                let st = r.spec.style.as_deref().unwrap_or("solid");
                if st == "bar" || st == "hist" {
                    has_bar_or_hist = true;
                }
                for p in &r.points {
                    let lo = p.y_low.unwrap_or_else(|| p.y - p.yerr.unwrap_or(0.0).abs());
                    let hi = p.y_high.unwrap_or_else(|| p.y + p.yerr.unwrap_or(0.0).abs());
                    min_y = min_y.min(lo);
                    max_y = max_y.max(hi);
                }
            }
            if has_bar_or_hist {
                min_y = min_y.min(0.0);
            }
            if !min_y.is_finite() || !max_y.is_finite() {
                [-1.1, 1.1]
            } else if (max_y - min_y).abs() < 1e-9 {
                [min_y - 1.0, max_y + 1.0]
            } else {
                let pad = (max_y - min_y) * 0.1;
                [if has_bar_or_hist && min_y >= 0.0 { 0.0 } else { min_y - pad }, max_y + pad]
            }
        };

        let [y_min, y_max] = compute_y_domain(false, req.spec.y_domain);
        let [y2_min, y2_max] = compute_y_domain(true, req.spec.y2_domain);

        let native_axes = req.native_axes.unwrap_or(true);

        // Margins: when native_axes is true, the entire canvas is pure plot area (zero rasterized axis labels!)
        let pad_left: f32 = if native_axes { 0.0 } else { 58.0 * dpr };
        let pad_right: f32 = if native_axes {
            if has_right_axis { 54.0 * dpr } else { 0.0 }
        } else if has_right_axis {
            58.0 * dpr
        } else {
            14.0 * dpr
        };
        let pad_top: f32 = if native_axes {
            2.0 * dpr
        } else if req.spec.y_label.is_some() || req.spec.y2_label.is_some() {
            22.0 * dpr
        } else {
            10.0 * dpr
        };
        let pad_bottom: f32 = if native_axes {
            2.0 * dpr
        } else if req.spec.x_label.is_some() {
            42.0 * dpr
        } else {
            26.0 * dpr
        };

        let plot_x = pad_left;
        let plot_y = pad_top;
        let plot_w = (w as f32 - pad_left - pad_right).max(80.0 * dpr);
        let plot_h = (h as f32 - pad_top - pad_bottom).max(60.0 * dpr);

        if !native_axes {
            draw_line(pixmap, plot_x, plot_y + plot_h, plot_x + plot_w, plot_y + plot_h, theme.border, 1.0 * dpr, None);
            draw_line(pixmap, plot_x, plot_y, plot_x, plot_y + plot_h, theme.border, 1.0 * dpr, None);
        }

        let map_x = |x: f64| -> f32 { plot_x + (((x - x_min) / (x_max - x_min)) as f32) * plot_w };
        let map_y_left = |y: f64| -> f32 { plot_y + (((y_max - y) / (y_max - y_min)) as f32) * plot_h };
        let map_y_right = |y: f64| -> f32 { plot_y + (((y2_max - y) / (y2_max - y2_min)) as f32) * plot_h };

        // Left Y grid & native tick metadata
        let mut y_tick_meta: Vec<AxisTick> = Vec::new();
        for &yv in &nice_ticks(y_min, y_max, 5) {
            let py = map_y_left(yv);
            if py < plot_y - 1.0 || py > plot_y + plot_h + 1.0 {
                continue;
            }
            let is_zero = yv.abs() < (y_max - y_min) * 1e-6;
            draw_line(
                pixmap,
                plot_x,
                py,
                plot_x + plot_w,
                py,
                if is_zero { theme.zero_axis } else { theme.grid },
                (if is_zero { 1.3 } else { 0.9 }) * dpr,
                None,
            );
            let lbl = format_tick(yv);
            y_tick_meta.push(AxisTick {
                pos: ((y_max - yv) / (y_max - y_min)).clamp(0.0, 1.0),
                label: lbl.clone(),
            });
            if !native_axes {
                self.draw_text_right(pixmap, &lbl, plot_x - 8.0 * dpr, py - 6.5 * dpr, 11.5 * dpr, theme.text_muted);
            }
        }

        // Right Y ticks (if dual axis)
        if has_right_axis {
            for &yv in &nice_ticks(y2_min, y2_max, 5) {
                let py = map_y_right(yv);
                if py < plot_y - 1.0 || py > plot_y + plot_h + 1.0 {
                    continue;
                }
                self.draw_text(pixmap, &format_tick(yv), plot_x + plot_w + 8.0 * dpr, py - 6.5 * dpr, 11.5 * dpr, theme.text_muted, false);
            }
        }

        // X grid & native tick metadata (categorical vs date vs numeric)
        let mut x_tick_meta: Vec<AxisTick> = Vec::new();
        if let Some(cats) = categories {
            let step = ((cats.len() as f32) / ((plot_w / (64.0 * dpr)).max(2.0))).ceil().max(1.0) as usize;
            for (i, cat) in cats.iter().enumerate() {
                if i % step != 0 {
                    continue;
                }
                let px = map_x(i as f64);
                if px < plot_x || px > plot_x + plot_w {
                    continue;
                }
                draw_line(pixmap, px, plot_y, px, plot_y + plot_h, theme.grid, 0.8 * dpr, None);
                x_tick_meta.push(AxisTick {
                    pos: ((i as f64 - x_min) / (x_max - x_min)).clamp(0.0, 1.0),
                    label: cat.clone(),
                });
                if !native_axes {
                    self.draw_text_center(pixmap, cat, px, plot_y + plot_h + 6.0 * dpr, 11.5 * dpr, theme.text_muted);
                }
            }
        } else {
            let x_ticks = nice_ticks(x_min, x_max, if is_date { 5 } else { 7 });
            for &xv in &x_ticks {
                let px = map_x(xv);
                if px < plot_x - 1.0 || px > plot_x + plot_w + 1.0 {
                    continue;
                }
                draw_line(pixmap, px, plot_y, px, plot_y + plot_h, theme.grid, 0.9 * dpr, None);
                let lbl = if is_date { format_date_tick(xv, x_max - x_min) } else { format_tick(xv) };
                x_tick_meta.push(AxisTick {
                    pos: ((xv - x_min) / (x_max - x_min)).clamp(0.0, 1.0),
                    label: lbl.clone(),
                });
                if !native_axes {
                    self.draw_text_center(pixmap, &lbl, px, plot_y + plot_h + 6.0 * dpr, 11.5 * dpr, theme.text_muted);
                }
            }
        }

        // Rasterized axis labels only when native_axes is disabled
        if !native_axes {
            if let Some(xl) = &req.spec.x_label {
                if !xl.is_empty() {
                    self.draw_text_center(pixmap, xl, plot_x + plot_w * 0.5, h as f32 - 19.0 * dpr, 12.0 * dpr, theme.text_muted);
                }
            }
            if let Some(yl) = &req.spec.y_label {
                if !yl.is_empty() {
                    self.draw_text(pixmap, yl, 8.0 * dpr, plot_y - 17.0 * dpr, 11.0 * dpr, theme.text_muted, false);
                }
            }
            if let Some(y2l) = &req.spec.y2_label {
                if !y2l.is_empty() {
                    self.draw_text_right(pixmap, y2l, w as f32 - 8.0 * dpr, plot_y - 17.0 * dpr, 11.0 * dpr, theme.text_muted);
                }
            }
        }

        // Group bar series index for side-by-side grouped bars
        let bar_series_indices: Vec<usize> = resolved
            .iter()
            .enumerate()
            .filter(|(_, r)| r.spec.style.as_deref() == Some("bar") && r.spec.stacked != Some(true))
            .map(|(i, _)| i)
            .collect();
        let mut stacked_pos_acc: HashMap<i64, f64> = HashMap::new();
        let mut stacked_neg_acc: HashMap<i64, f64> = HashMap::new();

        // Draw series
        for (s_idx, r) in resolved.iter().enumerate() {
            let col = hex(&r.color_hex);
            let style = r.spec.style.as_deref().unwrap_or("solid");
            let lw = r.spec.line_width.unwrap_or(if style == "dashed" { 1.6 } else { 2.6 }) * dpr;
            let map_y = |y: f64| -> f32 { if r.is_right { map_y_right(y) } else { map_y_left(y) } };
            let (cur_ymin, cur_ymax) = if r.is_right { (y2_min, y2_max) } else { (y_min, y_max) };

            match style {
                "band" => {
                    if r.points.len() >= 2 {
                        let mut pb = PathBuilder::new();
                        let mut started = false;
                        for p in &r.points {
                            let px = map_x(p.x).clamp(plot_x, plot_x + plot_w);
                            let py = map_y(p.y_high.unwrap_or(p.y)).clamp(plot_y, plot_y + plot_h);
                            if !started {
                                pb.move_to(px, py);
                                started = true;
                            } else {
                                pb.line_to(px, py);
                            }
                        }
                        for p in r.points.iter().rev() {
                            let px = map_x(p.x).clamp(plot_x, plot_x + plot_w);
                            let py = map_y(p.y_low.unwrap_or(p.y)).clamp(plot_y, plot_y + plot_h);
                            pb.line_to(px, py);
                        }
                        pb.close();
                        if let Some(path) = pb.finish() {
                            let mut fill = col;
                            fill.set_alpha(r.spec.opacity.unwrap_or(0.22).clamp(0.05, 0.8));
                            let mut paint = Paint::default();
                            paint.set_color(fill);
                            paint.anti_alias = true;
                            pixmap.fill_path(&path, &paint, FillRule::Winding, Transform::identity(), None);
                        }
                    }
                }
                "hist" => {
                    let bw_px = r
                        .hist_bin_width
                        .map(|bw| ((bw / (x_max - x_min)) as f32 * plot_w - 1.5).max(2.0))
                        .unwrap_or(10.0);
                    let base_y = map_y(0.0_f64.clamp(cur_ymin, cur_ymax));
                    let mut fill = col;
                    fill.set_alpha(r.spec.opacity.unwrap_or(0.78));
                    for p in &r.points {
                        let px = map_x(p.x) - bw_px * 0.5;
                        let py = map_y(p.y).clamp(plot_y, plot_y + plot_h);
                        let bh = (base_y - py).abs().max(1.0);
                        fill_rect(pixmap, px, py.min(base_y), bw_px, bh, fill);
                        stroke_rect(pixmap, px, py.min(base_y), bw_px, bh, col, 0.8);
                    }
                }
                "bar" => {
                    let n_pts = r.points.len().max(1) as f32;
                    let group_slot = if is_categorical {
                        (plot_w / (categories.map(|c| c.len()).unwrap_or(r.points.len()).max(1) as f32)) * 0.72
                    } else {
                        (plot_w / n_pts) * 0.68
                    };
                    if r.spec.stacked == Some(true) {
                        let bw = group_slot.clamp(4.0, 48.0);
                        for p in &r.points {
                            let key = (p.x * 1000.0).round() as i64;
                            let base_val = if p.y >= 0.0 {
                                let e = stacked_pos_acc.entry(key).or_insert(0.0);
                                let prev = *e;
                                *e += p.y;
                                prev
                            } else {
                                let e = stacked_neg_acc.entry(key).or_insert(0.0);
                                let prev = *e;
                                *e += p.y;
                                prev
                            };
                            let y0 = map_y(base_val).clamp(plot_y, plot_y + plot_h);
                            let y1 = map_y(base_val + p.y).clamp(plot_y, plot_y + plot_h);
                            let px = map_x(p.x) - bw * 0.5;
                            fill_rect(pixmap, px, y0.min(y1), bw, (y1 - y0).abs().max(1.0), col);
                        }
                    } else {
                        let num_groups = bar_series_indices.len().max(1);
                        let g_pos = bar_series_indices.iter().position(|&i| i == s_idx).unwrap_or(0);
                        let bw = (group_slot / num_groups as f32 - 1.5).clamp(3.0, 44.0);
                        let total_gw = bw * num_groups as f32 + (num_groups.saturating_sub(1) as f32) * 1.5;
                        let base_y = map_y(0.0_f64.clamp(cur_ymin, cur_ymax));
                        for p in &r.points {
                            let cx = map_x(p.x);
                            let px = cx - total_gw * 0.5 + g_pos as f32 * (bw + 1.5);
                            let py = map_y(p.y).clamp(plot_y, plot_y + plot_h);
                            fill_rect(pixmap, px, py.min(base_y), bw, (base_y - py).abs().max(1.0), col);
                        }
                    }
                }
                "errorbar" => {
                    // Connect centers with a crisp line + error bars with caps + circular markers
                    let mut pb = PathBuilder::new();
                    let mut started = false;
                    for p in &r.points {
                        let px = map_x(p.x);
                        let py = map_y(p.y).clamp(plot_y, plot_y + plot_h);
                        if !started {
                            pb.move_to(px, py);
                            started = true;
                        } else {
                            pb.line_to(px, py);
                        }
                    }
                    if let Some(path) = pb.finish() {
                        let mut paint = Paint::default();
                        paint.set_color(col);
                        paint.anti_alias = true;
                        let stroke = Stroke { width: lw, line_cap: LineCap::Round, line_join: LineJoin::Round, ..Stroke::default() };
                        pixmap.stroke_path(&path, &paint, &stroke, Transform::identity(), None);
                    }
                    let cap_half = 5.0 * dpr;
                    for p in &r.points {
                        let px = map_x(p.x);
                        let py = map_y(p.y).clamp(plot_y, plot_y + plot_h);
                        if px < plot_x - 2.0 || px > plot_x + plot_w + 2.0 {
                            continue;
                        }
                        let lo = p.y_low.unwrap_or_else(|| p.y - p.yerr.unwrap_or(0.0).abs());
                        let hi = p.y_high.unwrap_or_else(|| p.y + p.yerr.unwrap_or(0.0).abs());
                        let py_lo = map_y(lo).clamp(plot_y, plot_y + plot_h);
                        let py_hi = map_y(hi).clamp(plot_y, plot_y + plot_h);
                        let mut err_col = col;
                        err_col.set_alpha(0.75);
                        draw_line(pixmap, px, py_hi, px, py_lo, err_col, 1.4 * dpr, None);
                        draw_line(pixmap, px - cap_half, py_hi, px + cap_half, py_hi, err_col, 1.4 * dpr, None);
                        draw_line(pixmap, px - cap_half, py_lo, px + cap_half, py_lo, err_col, 1.4 * dpr, None);
                        fill_circle(pixmap, px, py, 3.8 * dpr, col);
                    }
                }
                "scatter" => {
                    for p in &r.points {
                        let px = map_x(p.x);
                        let py = map_y(p.y);
                        if px >= plot_x && px <= plot_x + plot_w && py >= plot_y && py <= plot_y + plot_h {
                            let radius = p.r.unwrap_or(lw.max(3.5));
                            let mut fill = col;
                            fill.set_alpha(r.spec.opacity.unwrap_or(0.85));
                            fill_circle(pixmap, px, py, radius, fill);
                        }
                    }
                }
                "area" => {
                    let base_y = map_y(0.0_f64.clamp(cur_ymin, cur_ymax));
                    let mut pb_fill = PathBuilder::new();
                    let mut pb_line = PathBuilder::new();
                    let mut first_x = None;
                    let mut last_x = None;
                    for p in &r.points {
                        let px = map_x(p.x);
                        let py = map_y(p.y).clamp(plot_y, plot_y + plot_h);
                        if px < plot_x - 2.0 || px > plot_x + plot_w + 2.0 {
                            continue;
                        }
                        if first_x.is_none() {
                            first_x = Some(px);
                            pb_fill.move_to(px, base_y);
                            pb_fill.line_to(px, py);
                            pb_line.move_to(px, py);
                        } else {
                            pb_fill.line_to(px, py);
                            pb_line.line_to(px, py);
                        }
                        last_x = Some(px);
                    }
                    if let (Some(_), Some(lx)) = (first_x, last_x) {
                        pb_fill.line_to(lx, base_y);
                        pb_fill.close();
                        if let Some(path) = pb_fill.finish() {
                            let mut fill = col;
                            fill.set_alpha(r.spec.opacity.unwrap_or(0.24));
                            let mut paint = Paint::default();
                            paint.set_color(fill);
                            paint.anti_alias = true;
                            pixmap.fill_path(&path, &paint, FillRule::Winding, Transform::identity(), None);
                        }
                    }
                    if let Some(path) = pb_line.finish() {
                        let mut paint = Paint::default();
                        paint.set_color(col);
                        paint.anti_alias = true;
                        let stroke = Stroke { width: lw, line_cap: LineCap::Round, line_join: LineJoin::Round, ..Stroke::default() };
                        pixmap.stroke_path(&path, &paint, &stroke, Transform::identity(), None);
                    }
                }
                "step" => {
                    let mut pb = PathBuilder::new();
                    let mut prev: Option<(f32, f32)> = None;
                    for p in &r.points {
                        let px = map_x(p.x);
                        let py = map_y(p.y).clamp(plot_y - 2.0, plot_y + plot_h + 2.0);
                        if px < plot_x - 2.0 || px > plot_x + plot_w + 2.0 {
                            prev = None;
                            continue;
                        }
                        if let Some((_, prev_y)) = prev {
                            pb.line_to(px, prev_y);
                            pb.line_to(px, py);
                        } else {
                            pb.move_to(px, py);
                        }
                        prev = Some((px, py));
                    }
                    if let Some(path) = pb.finish() {
                        let mut paint = Paint::default();
                        paint.set_color(col);
                        paint.anti_alias = true;
                        let stroke = Stroke { width: lw, line_cap: LineCap::Round, line_join: LineJoin::Miter, ..Stroke::default() };
                        pixmap.stroke_path(&path, &paint, &stroke, Transform::identity(), None);
                    }
                }
                _ => {
                    // solid / dashed
                    let dash = if style == "dashed" {
                        StrokeDash::new(vec![6.0 * dpr, 4.5 * dpr], 0.0)
                    } else {
                        None
                    };
                    let mut pb = PathBuilder::new();
                    let mut started = false;
                    for p in &r.points {
                        let px = map_x(p.x);
                        let py = map_y(p.y).clamp(plot_y - 2.0, plot_y + plot_h + 2.0);
                        if px < plot_x - 2.0 || px > plot_x + plot_w + 2.0 {
                            started = false;
                            continue;
                        }
                        if !started {
                            pb.move_to(px, py);
                            started = true;
                        } else {
                            pb.line_to(px, py);
                        }
                    }
                    if let Some(path) = pb.finish() {
                        let mut paint = Paint::default();
                        paint.set_color(col);
                        paint.anti_alias = true;
                        let stroke = Stroke {
                            width: lw,
                            line_cap: LineCap::Round,
                            line_join: LineJoin::Round,
                            dash,
                            ..Stroke::default()
                        };
                        pixmap.stroke_path(&path, &paint, &stroke, Transform::identity(), None);
                    }
                }
            }
        }

        // Annotations (hline / vline / vspan / hspan / arrow)
        if let Some(annos) = &req.spec.annotations {
            for a in annos {
                let col_hex = a.color.as_deref().unwrap_or("#e53e3e");
                let col = hex(col_hex);
                let dash = StrokeDash::new(vec![5.0 * dpr, 4.0 * dpr], 0.0);
                match a.kind.as_str() {
                    "hline" => {
                        let py = if a.y_axis.as_deref() == Some("right") { map_y_right(a.value) } else { map_y_left(a.value) };
                        if py >= plot_y && py <= plot_y + plot_h {
                            draw_line(pixmap, plot_x, py, plot_x + plot_w, py, col, 1.4 * dpr, dash);
                            if let Some(lbl) = &a.label {
                                self.draw_text_right(pixmap, lbl, plot_x + plot_w - 6.0 * dpr, (py - 16.0 * dpr).max(plot_y + 2.0 * dpr), 11.0 * dpr, text_hex(col_hex));
                            }
                        }
                    }
                    "vline" => {
                        let px = map_x(a.value);
                        if px >= plot_x && px <= plot_x + plot_w {
                            draw_line(pixmap, px, plot_y, px, plot_y + plot_h, col, 1.4 * dpr, dash);
                            if let Some(lbl) = &a.label {
                                self.draw_text(pixmap, lbl, (px + 5.0 * dpr).min(plot_x + plot_w - 60.0 * dpr), plot_y + 4.0 * dpr, 11.0 * dpr, text_hex(col_hex), false);
                            }
                        }
                    }
                    "vspan" => {
                        if let (Some(f), Some(t)) = (a.from, a.to) {
                            let x1 = map_x(f.min(t)).clamp(plot_x, plot_x + plot_w);
                            let x2 = map_x(f.max(t)).clamp(plot_x, plot_x + plot_w);
                            let mut fill = col;
                            fill.set_alpha(a.opacity.unwrap_or(0.14).clamp(0.03, 0.5));
                            fill_rect(pixmap, x1, plot_y, (x2 - x1).max(1.0), plot_h, fill);
                            if let Some(lbl) = &a.label {
                                self.draw_text_center(pixmap, lbl, (x1 + x2) * 0.5, plot_y + 6.0 * dpr, 10.5 * dpr, text_hex(col_hex));
                            }
                        }
                    }
                    "hspan" => {
                        if let (Some(f), Some(t)) = (a.from, a.to) {
                            let map_y = |v: f64| if a.y_axis.as_deref() == Some("right") { map_y_right(v) } else { map_y_left(v) };
                            let y1 = map_y(f.max(t)).clamp(plot_y, plot_y + plot_h);
                            let y2 = map_y(f.min(t)).clamp(plot_y, plot_y + plot_h);
                            let mut fill = col;
                            fill.set_alpha(a.opacity.unwrap_or(0.14).clamp(0.03, 0.5));
                            fill_rect(pixmap, plot_x, y1, plot_w, (y2 - y1).max(1.0), fill);
                            if let Some(lbl) = &a.label {
                                self.draw_text_right(pixmap, lbl, plot_x + plot_w - 6.0 * dpr, y1 + 4.0 * dpr, 10.5 * dpr, text_hex(col_hex));
                            }
                        }
                    }
                    "arrow" => {
                        if let (Some(ax), Some(ay)) = (a.x, a.y) {
                            let tx = map_x(ax).clamp(plot_x, plot_x + plot_w);
                            let ty = (if a.y_axis.as_deref() == Some("right") { map_y_right(ay) } else { map_y_left(ay) }).clamp(plot_y, plot_y + plot_h);
                            let sx = a.text_x.map(&map_x).unwrap_or_else(|| if tx > plot_x + plot_w * 0.6 { tx - 70.0 * dpr } else { tx + 50.0 * dpr }).clamp(plot_x + 8.0 * dpr, plot_x + plot_w - 8.0 * dpr);
                            let sy = a.text_y.map(|vy| if a.y_axis.as_deref() == Some("right") { map_y_right(vy) } else { map_y_left(vy) }).unwrap_or_else(|| (ty - 32.0 * dpr).max(plot_y + 16.0 * dpr)).clamp(plot_y + 10.0 * dpr, plot_y + plot_h - 10.0 * dpr);
                            draw_arrow(pixmap, sx, sy, tx, ty, col, 1.6 * dpr, dpr);
                            if let Some(lbl) = &a.label {
                                let lx = if sx <= tx { (sx - self.measure_text_width(lbl, 11.0 * dpr) - 4.0 * dpr).max(plot_x + 4.0 * dpr) } else { (sx + 4.0 * dpr).min(plot_x + plot_w - 60.0 * dpr) };
                                self.draw_text(pixmap, lbl, lx, (sy - 7.0 * dpr).max(plot_y + 2.0 * dpr), 11.0 * dpr, text_hex(col_hex), true);
                            }
                        }
                    }
                    _ => {}
                }
            }
        }

        // Legend lives in the native terminal card header.

        // Hover crosshair + highlight dots (readings display natively in the card header + lightweight inline badge)
        let mut hover_readings = None;
        if let Some(hx_raw) = req.hover_x {
            let hx = hx_raw.clamp(x_min, x_max);
            let px = map_x(hx);
            draw_line(pixmap, px, plot_y, px, plot_y + plot_h, theme.crosshair, 1.3 * dpr, None);

            let mut readings: Vec<HoverReading> = Vec::new();
            for r in &resolved {
                let map_y = |y: f64| -> f32 { if r.is_right { map_y_right(y) } else { map_y_left(y) } };
                let y_opt = if let Some(expr) = &r.parsed_expr {
                    let mut lv = vars.clone();
                    lv.insert("x".to_string(), hx);
                    lv.insert("t".to_string(), hx);
                    let v = expr.eval(&lv);
                    if v.is_finite() { Some((hx, v)) } else { None }
                } else {
                    r.points
                        .iter()
                        .min_by(|a, b| (a.x - hx).abs().partial_cmp(&(b.x - hx).abs()).unwrap_or(std::cmp::Ordering::Equal))
                        .map(|p| (p.x, p.y))
                };

                if let Some((rx, ry)) = y_opt {
                    let py = map_y(ry);
                    if py >= plot_y && py <= plot_y + plot_h {
                        fill_circle(pixmap, map_x(rx), py, 5.5 * dpr, hex(&r.color_hex));
                        fill_circle(pixmap, map_x(rx), py, 2.3 * dpr, hex("#ffffff"));
                    }
                    let x_str = if let Some(cats) = categories {
                        cats.get(rx.round().max(0.0) as usize)
                            .cloned()
                            .unwrap_or_else(|| format_tick(rx))
                    } else if is_date {
                        format_date_tick(rx, x_max - x_min)
                    } else {
                        format!("{:.2}", rx)
                    };
                    readings.push(HoverReading {
                        label: r.spec.label.clone(),
                        color: r.color_hex.clone(),
                        x: rx,
                        y: ry,
                        text: Some(format!("{}: x={}, y={:.3}", r.spec.label, x_str, ry)),
                    });
                }
            }

            if !readings.is_empty() {
                hover_readings = Some(readings);
            }
        }

        let plot_box = PlotBoxFrac {
            left: plot_x as f64 / w as f64,
            right: (plot_x + plot_w) as f64 / w as f64,
            top: plot_y as f64 / h as f64,
            bottom: (plot_y + plot_h) as f64 / h as f64,
        };
        self.finish(
            req.req_id,
            pixmap,
            [x_min, x_max],
            [y_min, y_max],
            plot_box,
            native_axes,
            Some(x_tick_meta),
            Some(y_tick_meta),
            hover_readings,
            t0,
        )
    }

    pub fn draw_text(
        &mut self,
        pixmap: &mut Pixmap,
        text: &str,
        x: f32,
        y: f32,
        size: f32,
        color: TextColor,
        bold: bool,
    ) {
        let fs = self.font_system.get_or_insert_with(FontSystem::new);
        let mut buffer = Buffer::new(fs, Metrics::new(size, size * 1.3));
        buffer.set_size(fs, Some(pixmap.width() as f32), Some(size * 2.0));
        let mut attrs = Attrs::new().family(Family::SansSerif);
        if bold {
            attrs = attrs.weight(cosmic_text::Weight::SEMIBOLD);
        }
        buffer.set_text(fs, text, attrs, Shaping::Advanced);
        buffer.shape_until_scroll(fs, false);

        let pw = pixmap.width() as i32;
        let ph = pixmap.height() as i32;
        let data = pixmap.data_mut();

        buffer.draw(fs, &mut self.swash_cache, color, |gx, gy, _gw, _gh, gcol| {
            let px = x as i32 + gx;
            let py = y as i32 + gy;
            if px < 0 || py < 0 || px >= pw || py >= ph {
                return;
            }
            let a = gcol.a() as u32;
            if a == 0 {
                return;
            }
            let idx = ((py * pw + px) * 4) as usize;
            let src_a = gcol.a() as u32;
            let dst_a = data[idx + 3] as u32;
            let inv_src = 255 - src_a;
            let out_a = src_a + (dst_a * inv_src + 127) / 255;
            if out_a == 0 {
                return;
            }
            // Porter-Duff source-over in premultiplied RGBA (matching tiny-skia Pixmap format)
            let sr = (gcol.r() as u32 * src_a + 127) / 255;
            let sg = (gcol.g() as u32 * src_a + 127) / 255;
            let sb = (gcol.b() as u32 * src_a + 127) / 255;
            data[idx] = (sr + (data[idx] as u32 * inv_src + 127) / 255).min(255) as u8;
            data[idx + 1] = (sg + (data[idx + 1] as u32 * inv_src + 127) / 255).min(255) as u8;
            data[idx + 2] = (sb + (data[idx + 2] as u32 * inv_src + 127) / 255).min(255) as u8;
            data[idx + 3] = out_a.min(255) as u8;
        });
    }

    pub fn measure_text_width(&mut self, text: &str, size: f32) -> f32 {
        let fs = self.font_system.get_or_insert_with(FontSystem::new);
        let mut buffer = Buffer::new(fs, Metrics::new(size, size * 1.3));
        buffer.set_size(fs, Some(800.0), Some(size * 2.0));
        buffer.set_text(fs, text, Attrs::new().family(Family::SansSerif), Shaping::Advanced);
        buffer.shape_until_scroll(fs, false);
        buffer.layout_runs().map(|r| r.line_w).fold(0.0_f32, f32::max)
    }

    pub fn draw_text_right(&mut self, pixmap: &mut Pixmap, text: &str, right_x: f32, y: f32, size: f32, color: TextColor) {
        let tw = self.measure_text_width(text, size);
        self.draw_text(pixmap, text, (right_x - tw).max(2.0), y, size, color, false);
    }

    pub fn draw_text_center(&mut self, pixmap: &mut Pixmap, text: &str, cx: f32, y: f32, size: f32, color: TextColor) {
        let tw = self.measure_text_width(text, size);
        self.draw_text(pixmap, text, (cx - tw * 0.5).max(2.0), y, size, color, false);
    }
}

pub fn fill_rect(pixmap: &mut Pixmap, x: f32, y: f32, w: f32, h: f32, color: Color) {
    if let Some(rect) = Rect::from_xywh(x, y, w, h) {
        let mut paint = Paint::default();
        paint.set_color(color);
        pixmap.fill_rect(rect, &paint, Transform::identity(), None);
    }
}

pub fn stroke_rect(pixmap: &mut Pixmap, x: f32, y: f32, w: f32, h: f32, color: Color, width: f32) {
    if let Some(rect) = Rect::from_xywh(x, y, w, h) {
        let path = PathBuilder::from_rect(rect);
        let mut paint = Paint::default();
        paint.set_color(color);
        let stroke = Stroke { width, ..Stroke::default() };
        pixmap.stroke_path(&path, &paint, &stroke, Transform::identity(), None);
    }
}

pub fn draw_line(pixmap: &mut Pixmap, x1: f32, y1: f32, x2: f32, y2: f32, color: Color, width: f32, dash: Option<StrokeDash>) {
    let mut pb = PathBuilder::new();
    pb.move_to(x1, y1);
    pb.line_to(x2, y2);
    if let Some(path) = pb.finish() {
        let mut paint = Paint::default();
        paint.set_color(color);
        paint.anti_alias = true;
        let stroke = Stroke { width, dash, ..Stroke::default() };
        pixmap.stroke_path(&path, &paint, &stroke, Transform::identity(), None);
    }
}

pub fn draw_arrow(pixmap: &mut Pixmap, x1: f32, y1: f32, x2: f32, y2: f32, color: Color, width: f32, dpr: f32) {
    let dx = x2 - x1;
    let dy = y2 - y1;
    let len = (dx * dx + dy * dy).sqrt().max(1.0);
    let ux = dx / len;
    let uy = dy / len;
    let head_len = 8.5 * dpr;
    let head_w = 4.2 * dpr;
    // Stop shaft slightly before tip so arrowhead looks sharp
    let sx2 = x2 - ux * (head_len * 0.7);
    let sy2 = y2 - uy * (head_len * 0.7);
    draw_line(pixmap, x1, y1, sx2, sy2, color, width, None);

    let bx = x2 - ux * head_len;
    let by = y2 - uy * head_len;
    let px = -uy * head_w;
    let py = ux * head_w;
    let mut pb = PathBuilder::new();
    pb.move_to(x2, y2);
    pb.line_to(bx + px, by + py);
    pb.line_to(bx - px, by - py);
    pb.close();
    if let Some(path) = pb.finish() {
        let mut paint = Paint::default();
        paint.set_color(color);
        paint.anti_alias = true;
        pixmap.fill_path(&path, &paint, FillRule::Winding, Transform::identity(), None);
    }
}

pub fn fill_circle(pixmap: &mut Pixmap, cx: f32, cy: f32, r: f32, color: Color) {
    if let Some(path) = PathBuilder::from_circle(cx, cy, r) {
        let mut paint = Paint::default();
        paint.set_color(color);
        paint.anti_alias = true;
        pixmap.fill_path(&path, &paint, FillRule::Winding, Transform::identity(), None);
    }
}

pub fn nice_ticks(min: f64, max: f64, count: usize) -> Vec<f64> {
    let span = max - min;
    if span <= 0.0 || !span.is_finite() {
        return vec![min];
    }
    let raw_step = span / (count.max(2) as f64);
    let mag = 10.0_f64.powf(raw_step.log10().floor());
    let norm = raw_step / mag;
    let step = if norm <= 1.5 {
        1.0 * mag
    } else if norm <= 3.0 {
        2.0 * mag
    } else if norm <= 7.0 {
        5.0 * mag
    } else {
        10.0 * mag
    };
    let start = (min / step).ceil() * step;
    let mut out = Vec::new();
    let mut v = start;
    while v <= max + step * 1e-6 && out.len() < 32 {
        out.push(if v.abs() < step * 1e-9 { 0.0 } else { v });
        v += step;
    }
    out
}

pub fn format_tick(v: f64) -> String {
    if v.abs() < 1e-9 {
        return "0".to_string();
    }
    if (v - v.round()).abs() < 1e-6 && v.abs() < 1e6 {
        format!("{}", v.round() as i64)
    } else if v.abs() >= 100.0 {
        format!("{:.0}", v)
    } else if v.abs() >= 1.0 {
        format!("{:.1}", v)
    } else {
        format!("{:.2}", v)
    }
}

/// Format Unix timestamp (seconds or milliseconds) as UTC date/time string without extra deps.
fn format_date_tick(ts: f64, span: f64) -> String {
    let secs = if ts.abs() > 1e11 { (ts / 1000.0).round() as i64 } else { ts.round() as i64 };
    let span_secs = if ts.abs() > 1e11 { span / 1000.0 } else { span };
    let days = secs.div_euclid(86400);
    let rem = secs.rem_euclid(86400);
    let hour = rem / 3600;
    let min = (rem % 3600) / 60;
    let (year, month, day) = civil_from_days(days);
    if span_secs <= 86400.0 * 2.0 {
        format!("{:02}-{:02} {:02}:{:02}", month, day, hour, min)
    } else if span_secs <= 86400.0 * 365.0 {
        format!("{:02}-{:02}", month, day)
    } else {
        format!("{:04}-{:02}", year, month)
    }
}

/// Howard Hinnant's civil_from_days algorithm (days since 1970-01-01 -> (Y, M, D)).
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (y + if m <= 2 { 1 } else { 0 }, m as u32, d as u32)
}

fn encode_fast_png(pixmap: &Pixmap) -> Vec<u8> {
    // Fast integer un-premultiply (zero float divisions) for clean alpha blending over terminal background
    let premul = pixmap.data();
    let mut straight = vec![0u8; premul.len()];
    for (src, dst) in premul.chunks_exact(4).zip(straight.chunks_exact_mut(4)) {
        let a = src[3];
        if a == 0 {
            continue;
        } else if a == 255 {
            dst.copy_from_slice(src);
        } else {
            let au = a as u32;
            dst[0] = ((src[0] as u32 * 255 + (au >> 1)) / au).min(255) as u8;
            dst[1] = ((src[1] as u32 * 255 + (au >> 1)) / au).min(255) as u8;
            dst[2] = ((src[2] as u32 * 255 + (au >> 1)) / au).min(255) as u8;
            dst[3] = a;
        }
    }
    let mut out = Vec::with_capacity(32 * 1024);
    {
        let mut enc = png::Encoder::new(&mut out, pixmap.width(), pixmap.height());
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        // Default compression + Sub filter keeps PNG ~20-30KB (6x smaller PTY payload vs Fast!) while still taking ~3-4ms.
        enc.set_compression(png::Compression::Default);
        enc.set_filter(png::FilterType::Sub);
        if let Ok(mut writer) = enc.write_header() {
            let _ = writer.write_image_data(&straight);
        }
    }
    out
}
