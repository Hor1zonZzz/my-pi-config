# inline-chart

Pi 原生内联可交互图表扩展（独立 Rust `tiny-skia` 引擎 + 终端原生圆角卡片与横纵坐标）。

- **真正内联**：通过 `pi.appendEntry` + `pi.registerEntryRenderer` 直接嵌在 Pi 对话流里，**原生支持 `codemode`**，不占 LLM 上下文，随对话滚动与分屏宽度自适应重排。
- **完全透明融合 + 原生文字**：标题、图例、悬停读数、横纵坐标刻度与轴标题、按钮与滑块全部由终端原生字体渲染；Rust 只渲染完全透明底（`alpha = 0`）的 2x Retina 矢量曲线与柔和网格，自动跟随终端浅色与深色主题。
- **支持 13 种图表样式**：`solid` / `dashed` / `area` / `step` / `band` / `scatter` / `bar`（分组/堆叠/分类轴）/ `barh` / `hist`（支持 `bins` 滑块）/ `boxplot` / `heatmap` / `pie` / `donut`，以及双 Y 轴、时间轴、参考线标注和任意数学公式求值。
- **零干扰交互**：鼠标悬停实时十字线读数、点击开关切换曲线、拖动滑块实时调参；完全不拦截滚轮和画布点击，对话滚动始终顺滑。
- **终端自适应启用**：在所有支持 Kitty Graphics 协议的终端（**Rex、Ghostty、Kitty、WezTerm、Warp、Herdr** 等）中自动激活；不支持图形协议的终端自动跳过。

## 构建 Rust 引擎

```sh
cd /Users/baai314/workspace/my-pi-config/extensions/inline-chart/engine
cargo build --release
cp target/release/inline-chart-engine ../bin/inline-chart-engine
```
