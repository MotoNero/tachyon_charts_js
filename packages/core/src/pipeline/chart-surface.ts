// The root of a chart: axes, panes and series, drawn in the passes of a frame (ChartSurface of the .NET version).
import type { Axis, TickSet } from '../axes/axis';
import { ColorAxis } from '../axes/color-axis';
import { DateTimeAxis } from '../axes/date-time-axis';
import { resolveTheme, toSurfaceStyle, type ThemeDocument } from '../themes/theme';
import type { HitResult, HitTestMode } from '../hit-testing/hit-test';
import type { Point } from '../input/primitives';
import { OverlayCanvas, type ChartOverlay } from '../overlays/chart-overlay';
import { drawAxisBreaks, hasAxisBreaks } from '../overlays/axis-break-marks';
import { drawContourLabels, hasContourLabels } from '../overlays/contour-labels';
import { chartText } from '../locale/culture';
import {
  arrangeChart,
  DipRect,
  type AxisPlacement,
  type ChartLayoutOptions,
  type ChartLayoutResult,
  type LayoutPane,
} from '../layout/chart-layout';
import { TextEngineMeasurer } from '../layout/text-engine-measurer';
import { DoubleRange } from '../numerics/range';
import type { LinearAxisTransform } from '../numerics/transform';
import { glyphStride, type CommandList } from '../render/commands';
import type { RenderDevice, RenderTarget } from '../render/device';
import { parseColor, type PixelRect, type Rgba8 } from '../render/types';
import type { TextEngine, TextFont } from '../text/engine';
import { SeriesFrame, type ChartSeries } from './chart-series';
import { defaultSurfaceStyle, type ChartSurfaceStyle } from './chart-surface-style';

const axisTitleInset = 7;
const defaultLabelSize = 11;
const defaultTitleSize = 14;
const autoRangePadding = 0.05;
const colorBarSegments = 64;
const defaultTick: Rgba8 = { r: 150, g: 160, b: 175, a: 255 };
const defaultText: Rgba8 = { r: 200, g: 208, b: 220, a: 255 };

interface FittedRange {
  min: number;
  max: number;
  padding: number;
  version: number;
}

/**
 * The root of a chart: axes, panes and series, drawn in the passes of a frame. Layout, ticks, grid and text change
 * rarely, so they stay until an axis, the title or the size changes; frames in between allocate nothing.
 *
 * A frame has three steps, as in the .NET version: {@link ChartSurface.beginRender} (snapshots, axes, layout),
 * {@link ChartSurface.prepareData} (work of the series without the device, such as resampling) and
 * {@link ChartSurface.finishRender} (uploads and drawing). {@link ChartSurface.render} runs all three.
 */
export class ChartSurface {
  private readonly horizontal: readonly Axis[];
  private readonly paneList: readonly LayoutPane[];
  private readonly axes: readonly Axis[];
  private readonly measurer: TextEngineMeasurer;
  private seriesList: ChartSeries[] = [];
  private frames: SeriesFrame[] = [];
  private palette: readonly Rgba8[] = [];
  private paletteKey = '[]';
  private titleText: string | undefined;
  private titleTextFont: TextFont | undefined;
  private surfaceStyle: ChartSurfaceStyle = defaultSurfaceStyle;
  private readonly paneRects: PixelRect[] = [];
  private readonly bandRects: PixelRect[] = [];
  private readonly minorGridRects: PixelRect[] = [];
  private readonly gridRects: PixelRect[] = [];
  private readonly borderRects: PixelRect[] = [];
  private readonly tickRects: PixelRect[] = [];
  private readonly colorBars: { bounds: PixelRect; top: Rgba8; bottom: Rgba8 }[] = [];
  private glyphs = new Float32Array(512 * glyphStride);
  private glyphCount = 0;
  private overlayList: ChartOverlay[] = [];
  private overlayChanges = 0;
  private renderedOverlays = -1;
  private zoomArea: DipRect | undefined;
  private readonly canvas: OverlayCanvas;
  private readonly fitted = new Map<Axis, FittedRange>();
  private lastDevice: RenderDevice | undefined;
  private layout: ChartLayoutResult | undefined;
  private structure = 0;
  private invalidated = true;
  private framesDrawn = 0;
  private drawnPoints = 0;
  private renderedStructure = -1;
  private renderedAxes = -1;
  private renderedSeries = -1;
  private layoutStructure = -1;
  private layoutAxes = -1;
  private renderedWidth = -1;
  private renderedHeight = -1;
  private renderedScale = -1;
  private labelSize = defaultLabelSize;
  private titleSize = defaultTitleSize;
  private tickColor = defaultTick;
  private labelColor = defaultText;
  private titleColor = defaultText;
  private crosshairColors: { line: Rgba8; fill: Rgba8; text: Rgba8 } | undefined;
  private themeDocument: ThemeDocument | undefined;
  private themeFamily: string | undefined;
  private ownAxisFont: TextFont | undefined;
  private glowRadius = 0;
  private glowIntensity = 0;
  private arrangeScale = 1;

  /**
   * @param horizontalAxes - The axes at the top and bottom; the first one draws the vertical grid lines.
   * @param panes - The panes, top first; the first axis of each draws its horizontal grid lines.
   * @param textEngine - Measures and lays out all text of the chart.
   * @param options - The distances of the layout.
   * @throws RangeError when an axis sits on the wrong side or there is no pane.
   */
  constructor(
    horizontalAxes: readonly Axis[],
    panes: readonly LayoutPane[],
    private readonly textEngine: TextEngine,
    private readonly options: ChartLayoutOptions = {},
  ) {
    this.horizontal = [...horizontalAxes];
    this.paneList = panes.map((pane) => ({ ...pane, axes: [...pane.axes] }));
    this.axes = [...this.horizontal, ...this.paneList.flatMap((pane) => pane.axes)];
    // The layout checks sides, panes and weights; a chart that cannot be laid out fails here, not in a frame.
    arrangeChart({ width: 0, height: 0 }, undefined, this.horizontal, this.paneList, {
      lineHeight: 0,
      measureWidth: () => 0,
    });
    this.measurer = new TextEngineMeasurer(textEngine, defaultLabelSize);
    this.canvas = new OverlayCanvas(textEngine);
  }

  /** The axes at the top and bottom. */
  get horizontalAxes(): readonly Axis[] {
    return this.horizontal;
  }

  /** The panes, top first. */
  get panes(): readonly LayoutPane[] {
    return this.paneList;
  }

  /** The series, in the order they are drawn. */
  get series(): readonly ChartSeries[] {
    return this.seriesList;
  }

  /** The title above the plot. */
  get title(): string | undefined {
    return this.titleText;
  }

  set title(value: string | undefined) {
    if (value !== this.titleText) {
      this.titleText = value;
      this.structure++;
    }
  }

  /** The font of the title; the default font of the engine when left out. */
  get titleFont(): TextFont | undefined {
    return this.titleTextFont;
  }

  set titleFont(value: TextFont | undefined) {
    if (value !== this.titleTextFont) {
      this.titleTextFont = value;
      this.structure++;
    }
  }

  /** The font of the axis labels and titles; the default font of the engine when left out. */
  get axisFont(): TextFont | undefined {
    return this.ownAxisFont;
  }

  set axisFont(value: TextFont | undefined) {
    if (value !== this.ownAxisFont) {
      this.ownAxisFont = value;
      this.measurer.font = this.withThemeFamily(value);
      this.structure++;
    }
  }

  /**
   * The theme: colors, text sizes and effects, in the JSON format of the .NET version; `undefined` for the colors of a
   * chart without a theme. Setting it resolves its base themes and replaces {@link ChartSurface.style}.
   * @throws Error when a base theme is unknown or a color cannot be read; RangeError for a text size that is not
   * positive and finite.
   */
  get theme(): ThemeDocument | undefined {
    return this.themeDocument;
  }

  set theme(value: ThemeDocument | undefined) {
    const resolved = value === undefined ? undefined : resolveTheme(value);
    this.applyTheme(resolved);
    // Series without colors of their own take those of a new palette, as OnPalette of the .NET version.
    const palette = (resolved?.palette ?? []).map((text) => parseColor(text));
    const key = JSON.stringify(palette);
    if (key !== this.paletteKey) {
      this.paletteKey = key;
      this.palette = palette;
      this.applyPalette();
    }
    this.structure++;
  }

  /** The colors of the background and grid passes. */
  get style(): ChartSurfaceStyle {
    return this.surfaceStyle;
  }

  set style(value: ChartSurfaceStyle) {
    if (value !== this.surfaceStyle) {
      this.surfaceStyle = value;
      this.structure++;
    }
  }

  /** The layout of the last frame, `undefined` before the first one. */
  get currentLayout(): ChartLayoutResult | undefined {
    return this.layout;
  }

  /** The number of frames drawn. */
  get frameCount(): number {
    return this.framesDrawn;
  }

  /** The points the series drew in the last frame. */
  get drawnPointCount(): number {
    return this.drawnPoints;
  }

  /**
   * Adds a series on top of the others.
   * @throws RangeError when its X axis is not a horizontal axis of this chart or its Y axis not in one of its panes.
   */
  addSeries(series: ChartSeries): void {
    if (!this.horizontal.includes(series.xAxis)) {
      throw new RangeError(`The X axis '${series.xAxis.id}' is not a horizontal axis of this chart.`);
    }
    if (!this.paneList.some((pane) => pane.axes.includes(series.yAxis))) {
      throw new RangeError(`The Y axis '${series.yAxis.id}' is not in a pane of this chart.`);
    }
    this.seriesList = [...this.seriesList, series];
    this.structure++;
    this.applyPalette();
  }

  /** Removes a series; returns whether it was there. */
  removeSeries(series: ChartSeries): boolean {
    if (!this.seriesList.includes(series)) {
      return false;
    }
    this.seriesList = this.seriesList.filter((item) => item !== series);
    this.structure++;
    return true;
  }

  /** The overlays, drawn above the series in this order. */
  get overlays(): readonly ChartOverlay[] {
    return this.overlayList;
  }

  /** Adds an overlay on top of the others. */
  addOverlay(overlay: ChartOverlay): void {
    if (!this.overlayList.includes(overlay)) {
      this.overlayList = [...this.overlayList, overlay];
      this.overlayChanges++;
      this.structure++;
    }
  }

  /** Removes an overlay; returns whether it was there. */
  removeOverlay(overlay: ChartOverlay): boolean {
    if (!this.overlayList.includes(overlay)) {
      return false;
    }
    this.overlayList = this.overlayList.filter((item) => item !== overlay);
    this.overlayChanges++;
    this.structure++;
    return true;
  }

  /** The preview of a zoom in device-independent units, `undefined` for none. */
  get zoomRectangle(): DipRect | undefined {
    return this.zoomArea;
  }

  set zoomRectangle(value: DipRect | undefined) {
    if (value !== this.zoomArea) {
      this.zoomArea = value;
      this.overlayChanges++;
    }
  }

  /**
   * The point of any visible series nearest to a position in device-independent units, within `maximumDistance`;
   * `undefined` for none or before the first frame.
   */
  hitTest(position: Point, maximumDistance: number, mode: HitTestMode): HitResult | undefined {
    let best: HitResult | undefined;
    for (let i = 0; i < this.seriesList.length; i++) {
      const hit = this.find(i, position, maximumDistance, mode);
      if (hit && (!best || hit.distance < best.distance)) {
        best = hit;
      }
    }
    return best;
  }

  /** The nearest point of every visible series within `maximumDistance` of a position. */
  hitTestAll(position: Point, maximumDistance: number, mode: HitTestMode): HitResult[] {
    const hits: HitResult[] = [];
    for (let i = 0; i < this.seriesList.length; i++) {
      const hit = this.find(i, position, maximumDistance, mode);
      if (hit) {
        hits.push(hit);
      }
    }
    return hits;
  }

  /** Lets go of what the chart keeps on a device that goes away, such as one of an export: its copy of the glyph atlas. */
  releaseDevice(device: RenderDevice): void {
    this.textEngine.releaseAtlas(device);
  }

  /** Asks for a new frame, for changes the chart cannot see. */
  invalidate(): void {
    this.invalidated = true;
  }

  /** Lays the chart out anew with the next frame, for changes of the room overlays take at the edges. */
  invalidateLayout(): void {
    this.structure++;
  }

  /** Whether anything changed since the last frame. */
  hasChanges(target: RenderTarget): boolean {
    return (
      this.invalidated ||
      this.renderedStructure !== this.structure ||
      this.renderedAxes !== this.sumAxisVersions() ||
      this.renderedSeries !== this.sumSeriesVersions() ||
      this.renderedOverlays !== this.sumOverlayVersions() ||
      this.renderedWidth !== target.size.width ||
      this.renderedHeight !== target.size.height ||
      this.renderedScale !== target.dpiScale
    );
  }

  /** Renders one frame: the three steps one after the other. */
  render(device: RenderDevice, target: RenderTarget): void {
    this.beginRender(device, target);
    this.prepareData();
    this.finishRender(device, target);
  }

  /** The first step of a frame: versions, snapshots, axes and layout. */
  beginRender(device: RenderDevice, target: RenderTarget): void {
    // The versions come first: a change during the frame then leads to another frame, none gets lost.
    this.invalidated = false;
    this.renderedStructure = this.structure;
    this.renderedSeries = this.sumSeriesVersions();
    this.renderedOverlays = this.sumOverlayVersions();
    for (const series of this.seriesList) {
      series.takeSnapshot();
    }
    this.fitAxes();
    this.renderedAxes = this.sumAxisVersions();
    if (
      this.layoutStructure !== this.renderedStructure ||
      this.layoutAxes !== this.renderedAxes ||
      this.renderedWidth !== target.size.width ||
      this.renderedHeight !== target.size.height ||
      this.renderedScale !== target.dpiScale
    ) {
      this.arrange(target);
    }
    // Resources of another device go before the work for the new one.
    if (this.lastDevice !== device) {
      if (this.lastDevice) {
        for (const series of this.seriesList) {
          series.releaseResources();
        }
      }
      this.lastDevice = device;
    }
  }

  /** The second step: the work of the series that needs no device, such as resampling. */
  prepareData(): void {
    const series = this.seriesList;
    for (let i = 0; i < series.length; i++) {
      (series[i] as ChartSeries).prepareData(this.frames[i] as SeriesFrame);
    }
  }

  /** The last step: uploads, drawing and handing the frame over. */
  finishRender(device: RenderDevice, target: RenderTarget): void {
    const series = this.seriesList;
    for (let i = 0; i < series.length; i++) {
      (series[i] as ChartSeries).prepare(device, this.frames[i] as SeriesFrame);
    }
    // Preparing can reveal new extremes. The axes then differ and lead to one more frame.
    this.fitAxes();
    const atlas = this.textEngine.atlasOn(device);
    const frame = device.beginFrame(target);
    try {
      const style = this.surfaceStyle;
      // Background pass.
      frame.clear(style.backgroundColor);
      this.fillPaneBackgrounds(frame);
      fill(frame, this.bandRects, style.bandColor);
      // Grid pass.
      fill(frame, this.minorGridRects, style.minorGridColor);
      fill(frame, this.gridRects, style.majorGridColor);
      fill(frame, this.borderRects, style.borderColor);
      // Series pass.
      let points = 0;
      for (let i = 0; i < series.length; i++) {
        const item = series[i] as ChartSeries;
        if (item.isVisible) {
          item.draw(frame, this.frames[i] as SeriesFrame);
          points += item.drawnPointCount;
        }
      }
      // Overlay pass: tick marks, the preview of a zoom, the overlays and all text.
      fill(frame, this.tickRects, this.tickColor);
      for (const bar of this.colorBars) {
        frame.fillLinearGradient(bar.bounds, bar.top, bar.bottom, true);
      }
      this.drawZoomRectangle(frame, target.dpiScale);
      const usedCanvas = this.drawOverlays(frame, target);
      if (this.glyphCount > 0) {
        frame.drawGlyphs(atlas, this.glyphs, this.glyphCount);
      }
      if (usedCanvas && this.canvas.glyphCount > 0) {
        // Overlays may have asked for new glyphs, which reach the texture only with this call.
        frame.drawGlyphs(this.textEngine.atlasOn(device), this.canvas.glyphs, this.canvas.glyphCount);
      }
      frame.submit();
      this.drawnPoints = points;
      this.framesDrawn++;
    } finally {
      frame.dispose();
    }
  }

  private drawZoomRectangle(frame: CommandList, scale: number): void {
    const area = this.zoomArea;
    if (!area) {
      return;
    }
    const pixels = area.toPixels(scale);
    const border = this.surfaceStyle.zoomRectangleBorderColor;
    frame.fillRectangle(pixels, this.surfaceStyle.zoomRectangleColor);
    frame.fillRectangle({ x: pixels.x, y: pixels.y, width: pixels.width, height: 1 }, border);
    frame.fillRectangle({ x: pixels.x, y: pixels.y + pixels.height - 1, width: pixels.width, height: 1 }, border);
    frame.fillRectangle({ x: pixels.x, y: pixels.y, width: 1, height: pixels.height }, border);
    frame.fillRectangle({ x: pixels.x + pixels.width - 1, y: pixels.y, width: 1, height: pixels.height }, border);
  }

  private drawOverlays(frame: CommandList, target: RenderTarget): boolean {
    const layout = this.layout;
    if (!layout) {
      return false;
    }
    const hasBreaks = hasAxisBreaks(layout);
    const hasLabels = hasContourLabels(this.seriesList);
    if (this.overlayList.length === 0 && !hasLabels && !hasBreaks) {
      return false;
    }
    const background = this.surfaceStyle.backgroundColor;
    this.canvas.begin(
      frame,
      layout,
      target.dpiScale,
      target.size.width / target.dpiScale,
      {
        accent: this.tickColor,
        text: this.labelColor,
        background,
        crosshair: this.crosshairColors?.line ?? this.tickColor,
        crosshairLabelFill: this.crosshairColors?.fill ?? this.tickColor,
        crosshairLabelText: this.crosshairColors?.text ?? background,
      },
      this.labelSize,
    );
    this.canvas.chartHeight = target.size.height / target.dpiScale;
    if (hasBreaks) {
      drawAxisBreaks(this.canvas, layout);
    }
    if (hasLabels) {
      drawContourLabels(this.canvas, layout, this.seriesList);
    }
    for (const overlay of this.overlayList) {
      overlay.draw(this.canvas);
      this.canvas.clip = undefined;
    }
    return true;
  }

  // Overlays outside the plot, such as legends, take room at the edges.
  private withRoom(): ChartLayoutOptions {
    let left = 0;
    let top = 0;
    let right = 0;
    let bottom = 0;
    for (const overlay of this.overlayList) {
      const room = overlay.reservedRoom(this.measurer);
      if (room) {
        left += room.left;
        top += room.top;
        right += room.right;
        bottom += room.bottom;
      }
    }
    return left + top + right + bottom === 0
      ? this.options
      : { ...this.options, reserved: { left, top, right, bottom } };
  }

  private sumOverlayVersions(): number {
    let sum = this.overlayChanges;
    for (const overlay of this.overlayList) {
      sum += overlay.version;
    }
    return sum;
  }

  // A hit of one series in the frame of its pane, in physical pixels.
  private find(index: number, position: Point, maximumDistance: number, mode: HitTestMode): HitResult | undefined {
    const series = this.seriesList[index];
    const frame = this.frames[index];
    if (!series?.isVisible || !frame) {
      return undefined;
    }
    const scale = frame.dpiScale;
    const pixelX = position.x * scale;
    const pixelY = position.y * scale;
    const bounds = frame.bounds;
    if (
      pixelX < bounds.x ||
      pixelX > bounds.x + bounds.width ||
      pixelY < bounds.y ||
      pixelY > bounds.y + bounds.height
    ) {
      return undefined;
    }
    const point = series.findPoint(frame, pixelX, pixelY, maximumDistance * scale, mode);
    if (!point) {
      return undefined;
    }
    const dx = frame.x.toPixel(point.x) - pixelX;
    const dy = mode === 'nearestX' ? 0 : frame.y.toPixel(point.y) - pixelY;
    return { ...point, series, distance: Math.hypot(dx, dy) / scale };
  }

  private applyPalette(): void {
    if (this.palette.length > 0) {
      for (const series of this.seriesList) {
        series.onPalette(this.palette);
      }
    }
  }

  private applyTheme(theme: ThemeDocument | undefined): void {
    const size = theme?.text?.size;
    if (size !== undefined && !(size > 0 && Number.isFinite(size))) {
      throw new RangeError(`The theme text size must be positive and finite, not ${String(size)}.`);
    }
    const color = (text: string | undefined, fallback: Rgba8): Rgba8 => (text ? parseColor(text) : fallback);
    this.surfaceStyle = theme ? toSurfaceStyle(theme) : defaultSurfaceStyle;
    this.tickColor = color(theme?.axis?.tick, defaultTick);
    this.labelColor = color(theme?.axis?.label, defaultText);
    this.titleColor = color(theme?.axis?.title, defaultText);
    const crosshair = theme?.crosshair;
    this.crosshairColors = crosshair && {
      line: color(crosshair.line, this.tickColor),
      fill: color(crosshair.labelBackground, this.tickColor),
      text: color(crosshair.labelText, this.surfaceStyle.backgroundColor),
    };
    this.themeFamily = firstFamily(theme?.text?.fontFamily);
    this.measurer.font = this.withThemeFamily(this.ownAxisFont);
    this.themeDocument = theme;
    const glow = theme?.effects?.glow;
    this.glowRadius = glow?.enabled === true ? (glow.radius ?? 0) : 0;
    this.glowIntensity = this.glowRadius > 0 ? (glow?.intensity ?? 0) : 0;
    this.labelSize = size ?? defaultLabelSize;
    this.titleSize = size === undefined ? defaultTitleSize : size + 3;
    this.measurer.size = this.labelSize;
  }

  // A font without a family of its own takes that of the theme.
  private withThemeFamily(font: TextFont | undefined): TextFont | undefined {
    return font?.family === undefined && this.themeFamily !== undefined ? { ...font, family: this.themeFamily } : font;
  }

  private fillPaneBackgrounds(frame: CommandList): void {
    const { plotGradientStart: start, plotGradientEnd: end } = this.surfaceStyle;
    const same = start.r === end.r && start.g === end.g && start.b === end.b && start.a === end.a;
    for (const rectangle of this.paneRects) {
      if (same) {
        frame.fillRectangle(rectangle, start);
      } else {
        frame.fillLinearGradient(rectangle, start, end, true);
      }
    }
  }

  // The labels follow the language of the charts, so a change of language lays them out anew.
  private sumAxisVersions(): number {
    let sum = chartText.version;
    for (const axis of this.axes) {
      sum += axis.version;
    }
    return sum;
  }

  private sumSeriesVersions(): number {
    let sum = 0;
    for (const series of this.seriesList) {
      sum += series.version + series.stateVersion;
    }
    return sum;
  }

  private fitAxes(): void {
    for (const axis of this.axes) {
      if (axis.isAutoRange) {
        this.fitAxis(axis);
      }
    }
  }

  // Without new objects per frame: the union is two numbers, and the axis is fitted only when they or it changed.
  private fitAxis(axis: Axis): void {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    // A color axis and an axis of a raster fit flush: a margin would only show a gap.
    let isFlush = axis.isHorizontal || axis instanceof ColorAxis;
    for (const series of this.seriesList) {
      const range = this.rangeFor(series, axis);
      if (range && !range.isEmpty) {
        min = Math.min(min, range.min);
        max = Math.max(max, range.max);
        isFlush ||= series.colorAxis !== undefined;
      }
    }
    if (min > max) {
      return;
    }
    const padding = isFlush ? 0 : autoRangePadding;
    const last = this.fitted.get(axis);
    if (last?.min === min && last.max === max && last.padding === padding && last.version === axis.version) {
      return;
    }
    if (axis instanceof DateTimeAxis) {
      // Series report time relative to the origin, as their values on the axis.
      axis.fitToTime(axis.origin + BigInt(Math.trunc(min)), axis.origin + BigInt(Math.trunc(max)), padding);
    } else {
      axis.fitTo(new DoubleRange(min, max), padding);
    }
    this.fitted.set(axis, { min, max, padding, version: axis.version });
  }

  // What a series adds to the range of an axis: its values for its color axis, its data for its X or Y axis.
  private rangeFor(series: ChartSeries, axis: Axis): DoubleRange | undefined {
    if (!series.isVisible) {
      return undefined;
    }
    if (axis instanceof ColorAxis) {
      return series.colorAxis === axis ? series.colorRange() : undefined;
    }
    if (series.xAxis !== axis && series.yAxis !== axis) {
      return undefined;
    }
    return series.dataRange(series.xAxis === axis ? 'x' : 'y');
  }

  private arrange(target: RenderTarget): void {
    const scale = target.dpiScale;
    this.arrangeScale = scale;
    const size = { width: target.size.width / scale, height: target.size.height / scale };
    const layout = arrangeChart(size, this.titleText, this.horizontal, this.paneList, this.measurer, this.withRoom());
    this.paneRects.length = 0;
    this.bandRects.length = 0;
    this.minorGridRects.length = 0;
    this.gridRects.length = 0;
    this.borderRects.length = 0;
    this.tickRects.length = 0;
    this.colorBars.length = 0;
    this.glyphCount = 0;
    for (const pane of layout.panes) {
      const pixels = pane.toPixels(scale);
      this.paneRects.push(pixels);
      this.addBorder(pixels);
    }
    if (this.titleText) {
      const font = this.withThemeFamily(this.titleTextFont);
      const width = this.textEngine.measureWidth(this.titleText, this.titleSize, font);
      const left = layout.title.x + (layout.title.width - width) / 2;
      this.addText(this.titleText, left, layout.title.bottom - 2, this.titleSize, this.titleColor, scale, font);
    }
    for (const placement of layout.axes) {
      this.arrangeAxis(placement, layout, scale);
    }
    this.arrangeSeries(layout, scale);
    this.layout = layout;
    this.layoutStructure = this.renderedStructure;
    this.layoutAxes = this.renderedAxes;
    this.renderedWidth = target.size.width;
    this.renderedHeight = target.size.height;
    this.renderedScale = scale;
  }

  private arrangeAxis(placement: AxisPlacement, layout: ChartLayoutResult, scale: number): void {
    const axis = placement.axis;
    if (axis.isHidden) {
      return;
    }
    let bounds = placement.bounds;
    const isHorizontal = axis.isHorizontal;
    const origin = ChartSurface.origin(axis, layout);
    if (axis.crossesAt !== undefined) {
      bounds = this.crossing(axis, axis.crossesAt, bounds, layout, scale);
    }
    const length = isHorizontal ? bounds.width : bounds.height;
    const transform = axis.createTransform(isHorizontal ? bounds.x : bounds.y, length);
    const drawsGrid = this.ownsGrid(axis);
    if (axis instanceof ColorAxis) {
      bounds = this.placeColorBar(axis, bounds, scale);
    }
    const ticks = axis.generateTicks(length, this.measurer);
    for (const tick of ticks.major) {
      const position = transform.toPixel(tick.value);
      // Where both axes cross, only the horizontal one writes its label.
      const label = Math.abs(position - origin) < 3 ? '' : tick.label;
      this.arrangeTick(axis, label, position, bounds, scale);
      if (drawsGrid) {
        this.addGridLine(this.gridRects, position, isHorizontal, bounds, layout, scale);
      }
    }
    if (drawsGrid) {
      this.addMinorGrid(ticks, transform, isHorizontal, bounds, layout, scale);
    }
    if (axis.title) {
      this.arrangeAxisTitle(axis.title, axis, bounds, scale);
    }
  }

  // Moves an axis onto the line through the plot where the other axis has the value, and draws that line.
  private crossing(axis: Axis, value: number, bounds: DipRect, layout: ChartLayoutResult, scale: number): DipRect {
    const plot = layout.plotArea;
    const other = ChartSurface.other(axis, layout);
    if (!other) {
      return bounds;
    }
    const otherBounds = other.bounds;
    const transform = other.axis.createTransform(
      axis.isHorizontal ? otherBounds.y : otherBounds.x,
      axis.isHorizontal ? otherBounds.height : otherBounds.width,
    );
    let at = transform.toPixel(value);
    if (axis.isHorizontal) {
      at = Number.isFinite(at) ? Math.min(Math.max(at, plot.y), plot.bottom) : plot.bottom;
      this.tickRects.push(new DipRect(bounds.x, at, bounds.width, 1).toPixels(scale));
      return axis.position === 'top'
        ? new DipRect(bounds.x, at - bounds.height, bounds.width, bounds.height)
        : new DipRect(bounds.x, at, bounds.width, bounds.height);
    }
    at = Number.isFinite(at) ? Math.min(Math.max(at, plot.x), plot.right) : plot.x;
    this.tickRects.push(new DipRect(at, bounds.y, 1, bounds.height).toPixels(scale));
    return axis.position === 'right'
      ? new DipRect(at, bounds.y, bounds.width, bounds.height)
      : new DipRect(at - bounds.width, bounds.y, bounds.width, bounds.height);
  }

  // The place of a horizontal axis that runs through the plot, for a vertical axis that must leave its label out there.
  private static origin(axis: Axis, layout: ChartLayoutResult): number {
    const other = ChartSurface.other(axis, layout);
    if (axis.isHorizontal || other?.axis.crossesAt === undefined) {
      return Number.NaN;
    }
    const own = layout.axes.find((placement) => placement.axis === axis);
    return own ? axis.createTransform(own.bounds.y, own.bounds.height).toPixel(other.axis.crossesAt) : Number.NaN;
  }

  // The first axis of the other direction; a color axis has no other.
  private static other(axis: Axis, layout: ChartLayoutResult): AxisPlacement | undefined {
    return layout.axes.find(
      (placement) => placement.axis.isHorizontal !== axis.isHorizontal && !(placement.axis instanceof ColorAxis),
    );
  }

  // The color bar beside the plot; ticks and labels start after it.
  private placeColorBar(axis: ColorAxis, bounds: DipRect, scale: number): DipRect {
    const band = axis.bandThickness;
    if (axis.position === 'left') {
      this.addColorBar(axis, new DipRect(bounds.right - band, bounds.y, band, bounds.height), scale);
      return new DipRect(bounds.x, bounds.y, bounds.width - band, bounds.height);
    }
    this.addColorBar(axis, new DipRect(bounds.x, bounds.y, band, bounds.height), scale);
    return new DipRect(bounds.x + band, bounds.y, bounds.width - band, bounds.height);
  }

  // Segments of linear gradients, linear in the scale of the axis like the raster; the top is the end of the map.
  private addColorBar(axis: ColorAxis, bar: DipRect, scale: number): void {
    for (let i = 0; i < colorBarSegments; i++) {
      const top = 1 - i / colorBarSegments;
      const bottom = 1 - (i + 1) / colorBarSegments;
      const segment = new DipRect(bar.x, bar.y + (1 - top) * bar.height, bar.width, bar.height / colorBarSegments);
      this.colorBars.push({
        bounds: segment.toPixels(scale),
        top: axis.colormap.sample(top),
        bottom: axis.colormap.sample(bottom),
      });
    }
  }

  private arrangeTick(axis: Axis, label: string, position: number, bounds: DipRect, scale: number): void {
    const tickLength = this.options.tickLength ?? 5;
    const labelDistance = tickLength + (this.options.labelGap ?? 3);
    const width = this.measurer.measureWidth(label);
    let mark: DipRect;
    let labelX: number;
    let baseline: number;
    switch (axis.position) {
      case 'bottom':
        mark = new DipRect(position, bounds.y, 1, tickLength);
        labelX = position - width / 2;
        baseline = bounds.y + labelDistance + this.labelSize;
        break;
      case 'top':
        mark = new DipRect(position, bounds.bottom - tickLength, 1, tickLength);
        labelX = position - width / 2;
        baseline = bounds.bottom - labelDistance - 1;
        break;
      case 'left':
        mark = new DipRect(bounds.right - tickLength, position, tickLength, 1);
        labelX = bounds.right - labelDistance - width;
        baseline = position + this.labelSize * 0.36;
        break;
      default:
        mark = new DipRect(bounds.x, position, tickLength, 1);
        labelX = bounds.x + labelDistance;
        baseline = position + this.labelSize * 0.36;
        break;
    }
    this.tickRects.push(mark.toPixels(scale));
    if (axis.labelRotation !== 0 && axis.isHorizontal) {
      // The text ends at its tick and turns around that point.
      const pivot = axis.position === 'bottom' ? bounds.y + labelDistance : bounds.bottom - labelDistance;
      const inwards = axis.labelRotation < 0 ? 1 : -1;
      this.addTurnedText(
        label,
        position - width,
        pivot + this.labelSize * 0.36 * inwards,
        position,
        pivot,
        axis.labelRotation,
        this.labelColor,
      );
    } else {
      this.addText(label, labelX, baseline, this.labelSize, this.labelColor, scale, this.measurer.font);
    }
  }

  private arrangeAxisTitle(title: string, axis: Axis, bounds: DipRect, scale: number): void {
    const width = this.measurer.measureWidth(title);
    const font = this.measurer.font;
    switch (axis.position) {
      case 'bottom':
        this.addText(
          title,
          bounds.x + (bounds.width - width) / 2,
          bounds.bottom - 2,
          this.labelSize,
          this.titleColor,
          scale,
          font,
        );
        break;
      case 'top':
        this.addText(
          title,
          bounds.x + (bounds.width - width) / 2,
          bounds.y + this.labelSize,
          this.labelSize,
          this.titleColor,
          scale,
          font,
        );
        break;
      default: {
        const x = axis.position === 'left' ? bounds.x + axisTitleInset : bounds.right - axisTitleInset;
        const y = bounds.y + bounds.height / 2;
        const degrees = axis.position === 'left' ? -90 : 90;
        this.addTurnedText(title, x - width / 2, y + this.labelSize * 0.36, x, y, degrees, this.titleColor);
        break;
      }
    }
  }

  // The first horizontal axis and the first axis of each pane draw the grid.
  private ownsGrid(axis: Axis): boolean {
    return axis.isHorizontal ? this.horizontal[0] === axis : this.paneList.some((pane) => pane.axes[0] === axis);
  }

  private addGridLine(
    rectangles: PixelRect[],
    position: number,
    isHorizontal: boolean,
    axisBounds: DipRect,
    layout: ChartLayoutResult,
    scale: number,
  ): void {
    for (const pane of layout.panes) {
      if (isHorizontal) {
        rectangles.push(new DipRect(position, pane.y, 1, pane.height).toPixels(scale));
      } else if (pane.y >= axisBounds.y - 0.5 && pane.bottom <= axisBounds.bottom + 0.5) {
        rectangles.push(new DipRect(pane.x, position, pane.width, 1).toPixels(scale));
      }
    }
  }

  private addMinorGrid(
    ticks: TickSet,
    transform: LinearAxisTransform,
    isHorizontal: boolean,
    bounds: DipRect,
    layout: ChartLayoutResult,
    scale: number,
  ): void {
    for (const value of ticks.minor) {
      this.addGridLine(this.minorGridRects, transform.toPixel(value), isHorizontal, bounds, layout, scale);
    }
    if (isHorizontal && this.surfaceStyle.bandColor.a !== 0) {
      for (let i = 0; i + 1 < ticks.major.length; i += 2) {
        const first = transform.toPixel((ticks.major[i] as { value: number }).value);
        const second = transform.toPixel((ticks.major[i + 1] as { value: number }).value);
        for (const pane of layout.panes) {
          this.bandRects.push(
            new DipRect(Math.min(first, second), pane.y, Math.abs(second - first), pane.height).toPixels(scale),
          );
        }
      }
    }
  }

  private addBorder(pane: PixelRect): void {
    this.borderRects.push(
      { x: pane.x, y: pane.y, width: pane.width, height: 1 },
      { x: pane.x, y: pane.y + pane.height - 1, width: pane.width, height: 1 },
      { x: pane.x, y: pane.y, width: 1, height: pane.height },
      { x: pane.x + pane.width - 1, y: pane.y, width: 1, height: pane.height },
    );
  }

  private arrangeSeries(layout: ChartLayoutResult, scale: number): void {
    this.frames = this.seriesList.map((series) => {
      const index = this.paneList.findIndex((pane) => pane.axes.includes(series.yAxis));
      const bounds = (layout.panes[index] as DipRect).toPixels(scale);
      return new SeriesFrame(
        bounds,
        series.xAxis.createTransform(bounds.x, bounds.width),
        series.yAxis.createTransform(bounds.y, bounds.height),
        scale,
        this.glowRadius * scale,
        this.glowIntensity,
      );
    });
  }

  // Text turned around a pivot, such as the titles of vertical axes and rotated labels.
  private addTurnedText(
    text: string,
    x: number,
    baseline: number,
    pivotX: number,
    pivotY: number,
    degrees: number,
    color: Rgba8,
  ): void {
    const first = this.glyphCount;
    const scale = this.arrangeScale;
    this.addText(text, x, baseline, this.labelSize, color, scale, this.measurer.font);
    const radians = Math.fround((degrees * Math.PI) / 180);
    for (let i = first; i < this.glyphCount; i++) {
      const at = i * glyphStride;
      this.glyphs[at + 10] = radians;
      this.glyphs[at + 11] = Math.fround(pivotX * scale);
      this.glyphs[at + 12] = Math.fround(pivotY * scale);
    }
  }

  private addText(
    text: string,
    x: number,
    baseline: number,
    size: number,
    color: Rgba8,
    scale: number,
    font: TextFont | undefined,
  ): void {
    const needed = (this.glyphCount + text.length) * glyphStride;
    if (needed > this.glyphs.length) {
      const grown = new Float32Array(Math.max(this.glyphs.length * 2, needed));
      grown.set(this.glyphs.subarray(0, this.glyphCount * glyphStride));
      this.glyphs = grown;
    }
    const style = font ? { size: Math.fround(size * scale), color, font } : { size: Math.fround(size * scale), color };
    this.glyphCount += this.textEngine.layout(
      text,
      Math.fround(x * scale),
      Math.fround(baseline * scale),
      style,
      this.glyphs,
      this.glyphCount,
    );
  }
}

function fill(frame: CommandList, rectangles: readonly PixelRect[], color: Rgba8): void {
  if (color.a !== 0) {
    for (const rectangle of rectangles) {
      frame.fillRectangle(rectangle, color);
    }
  }
}

// The first family a theme names; the embedded Roboto is the default font of the engine.
function firstFamily(families: string | undefined): string | undefined {
  const first = families
    ?.split(',')
    .map((name) => name.trim())
    .find((name) => name !== '');
  return first === undefined || first.toLowerCase() === 'roboto' ? undefined : first;
}
