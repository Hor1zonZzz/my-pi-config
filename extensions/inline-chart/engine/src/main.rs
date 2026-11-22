mod expr;
mod render;
mod render_special;
mod spec;

use crate::render::Renderer;
use crate::spec::{PlotBoxFrac, RenderRequest, RenderResponse};
use std::io::{self, BufRead, Write};

fn main() {
    let mut renderer = Renderer::new();
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut out = io::BufWriter::new(stdout.lock());

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let resp = match serde_json::from_str::<RenderRequest>(trimmed) {
            Ok(req) => renderer.render(&req),
            Err(err) => RenderResponse {
                req_id: 0,
                ok: false,
                error: Some(format!("invalid request json: {err}")),
                png_base64: None,
                width_px: 0,
                height_px: 0,
                x_domain: [0.0, 1.0],
                y_domain: [0.0, 1.0],
                plot_box: PlotBoxFrac {
                    left: 0.0,
                    right: 1.0,
                    top: 0.0,
                    bottom: 1.0,
                },
                native_axes_used: false,
                x_ticks: None,
                y_ticks: None,
                hover_readings: None,
                render_ms: 0.0,
                draw_ms: 0.0,
                encode_ms: 0.0,
            },
        };

        if let Ok(json) = serde_json::to_string(&resp) {
            let _ = writeln!(out, "{json}");
            let _ = out.flush();
        }
    }
}
