use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Deserialize)]
pub struct ChartPoint {
    pub x: f64,
    pub y: f64,
    #[serde(default, rename = "yLow")]
    pub y_low: Option<f64>,
    #[serde(default, rename = "yHigh")]
    pub y_high: Option<f64>,
    #[serde(default)]
    pub r: Option<f32>,
    #[serde(default)]
    pub label: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct BoxGroup {
    pub label: String,
    #[serde(default)]
    pub values: Option<Vec<f64>>,
    #[serde(default)]
    pub min: Option<f64>,
    #[serde(default)]
    pub q1: Option<f64>,
    #[serde(default)]
    pub median: Option<f64>,
    #[serde(default)]
    pub q3: Option<f64>,
    #[serde(default)]
    pub max: Option<f64>,
    #[serde(default)]
    pub color: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PieSlice {
    pub label: String,
    pub value: f64,
    #[serde(default)]
    pub color: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ChartAnnotation {
    /// "hline" | "vline"
    pub kind: String,
    pub value: f64,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
    /// "left" | "right" (for hline)
    #[serde(default, rename = "yAxis")]
    pub y_axis: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ChartSeries {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub color: Option<String>,
    /// "solid" | "dashed" | "area" | "step" | "scatter" | "bar" | "barh" | "band" | "hist" | "boxplot" | "heatmap" | "pie" | "donut"
    #[serde(default)]
    pub style: Option<String>,
    #[serde(default, rename = "lineWidth")]
    pub line_width: Option<f32>,
    #[serde(default)]
    pub opacity: Option<f32>,
    #[serde(default)]
    pub toggleable: Option<bool>,
    #[serde(default)]
    pub visible: Option<bool>,
    /// "left" (default) | "right"
    #[serde(default, rename = "yAxis")]
    pub y_axis: Option<String>,
    #[serde(default)]
    pub stacked: Option<bool>,
    #[serde(default)]
    pub points: Option<Vec<ChartPoint>>,
    /// Mathematical expression in terms of x (or t) and control variable names.
    #[serde(default)]
    pub formula: Option<String>,
    #[serde(default, rename = "formulaLow")]
    pub formula_low: Option<String>,
    #[serde(default, rename = "formulaHigh")]
    pub formula_high: Option<String>,
    /// Raw 1D values for histogram (`style: "hist"`).
    #[serde(default)]
    pub values: Option<Vec<f64>>,
    #[serde(default)]
    pub bins: Option<usize>,
    /// Groups for boxplot (`style: "boxplot"`).
    #[serde(default)]
    pub groups: Option<Vec<BoxGroup>>,
    /// 2D matrix [row][col] for heatmap (`style: "heatmap"`).
    #[serde(default)]
    pub matrix: Option<Vec<Vec<f64>>>,
    #[serde(default, rename = "xLabels")]
    pub x_labels: Option<Vec<String>>,
    #[serde(default, rename = "yLabels")]
    pub y_labels: Option<Vec<String>>,
    /// Slices for pie / donut (`style: "pie"` | `"donut"`).
    #[serde(default)]
    pub slices: Option<Vec<PieSlice>>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ChartControl {
    pub id: String,
    pub label: String,
    pub min: f64,
    pub max: f64,
    pub step: f64,
    pub value: f64,
    #[serde(default)]
    pub unit: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ChartSpec {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub kicker: Option<String>,
    pub title: String,
    #[serde(default)]
    pub subtitle: Option<String>,
    #[serde(default, rename = "xLabel")]
    pub x_label: Option<String>,
    #[serde(default, rename = "yLabel")]
    pub y_label: Option<String>,
    #[serde(default, rename = "y2Label")]
    pub y2_label: Option<String>,
    /// "number" (default) | "date" | "category"
    #[serde(default, rename = "xType")]
    pub x_type: Option<String>,
    /// Category labels for categorical bar/line/barh charts.
    #[serde(default)]
    pub categories: Option<Vec<String>>,
    #[serde(default, rename = "xDomain")]
    pub x_domain: Option<[f64; 2]>,
    #[serde(default, rename = "yDomain")]
    pub y_domain: Option<[f64; 2]>,
    #[serde(default, rename = "y2Domain")]
    pub y2_domain: Option<[f64; 2]>,
    #[serde(default)]
    pub samples: Option<usize>,
    #[serde(default)]
    pub params: Option<HashMap<String, f64>>,
    #[serde(default)]
    pub annotations: Option<Vec<ChartAnnotation>>,
    #[serde(default, rename = "showLegend")]
    pub show_legend: Option<bool>,
    pub series: Vec<ChartSeries>,
    #[serde(default)]
    pub controls: Option<Vec<ChartControl>>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct ThemePalette {
    #[serde(default)]
    pub bg: Option<String>,
    #[serde(default)]
    pub plot_bg: Option<String>,
    #[serde(default)]
    pub border: Option<String>,
    #[serde(default)]
    pub grid: Option<String>,
    #[serde(default)]
    pub text_primary: Option<String>,
    #[serde(default)]
    pub text_muted: Option<String>,
    #[serde(default)]
    pub accent: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct RenderRequest {
    pub req_id: u64,
    pub width_px: u32,
    pub height_px: u32,
    /// HiDPI scale factor (e.g. 2.0 on Retina) so fonts, strokes, and padding stay crisp and readable.
    #[serde(default)]
    pub dpr: Option<f32>,
    /// When true (default for cartesian charts), omit rasterized axis ticks/labels/borders and return tick metadata for native terminal rendering.
    #[serde(default)]
    pub native_axes: Option<bool>,
    pub spec: ChartSpec,
    #[serde(default)]
    pub control_values: HashMap<String, f64>,
    #[serde(default)]
    pub hidden_series: Vec<String>,
    /// Data-space X coordinate under cursor (for cartesian charts).
    #[serde(default)]
    pub hover_x: Option<f64>,
    /// Normalized canvas X/Y in [0..1] (for barh / heatmap / pie hover).
    #[serde(default)]
    pub hover_norm_x: Option<f64>,
    #[serde(default)]
    pub hover_norm_y: Option<f64>,
    /// Optional overridden X domain (for wheel zoom / pan).
    #[serde(default)]
    pub view_x_domain: Option<[f64; 2]>,
    /// "dark" | "light"
    #[serde(default)]
    pub theme: Option<String>,
    /// Optional concrete colors extracted from the host terminal / Pi theme.
    #[serde(default)]
    pub palette: Option<ThemePalette>,
}

#[derive(Debug, Serialize)]
pub struct PlotBoxFrac {
    pub left: f64,
    pub right: f64,
    pub top: f64,
    pub bottom: f64,
}

#[derive(Debug, Serialize)]
pub struct HoverReading {
    pub label: String,
    pub color: String,
    pub x: f64,
    pub y: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct AxisTick {
    /// Normalized position along axis in [0.0, 1.0]. For X: 0=left, 1=right. For Y: 0=top, 1=bottom.
    pub pos: f64,
    pub label: String,
}

#[derive(Debug, Serialize)]
pub struct RenderResponse {
    pub req_id: u64,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub png_base64: Option<String>,
    pub width_px: u32,
    pub height_px: u32,
    pub x_domain: [f64; 2],
    pub y_domain: [f64; 2],
    pub plot_box: PlotBoxFrac,
    pub native_axes_used: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub x_ticks: Option<Vec<AxisTick>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub y_ticks: Option<Vec<AxisTick>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hover_readings: Option<Vec<HoverReading>>,
    pub render_ms: f64,
    pub draw_ms: f64,
    pub encode_ms: f64,
}
