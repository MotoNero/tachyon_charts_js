// The web component <tachyon-chart>: a canvas in its own shadow root that follows the size and pixel ratio of the
// element, draws a chart when it changes, takes the input of the user and frees its GPU resources when removed.
import {
  AxisDragModifier,
  ChartBuilder,
  ChartDefinition,
  ChartInteraction,
  ChartSurface,
  CrosshairModifier,
  findBuiltInTheme,
  KeyboardNavigationModifier,
  ModifierPipeline,
  RubberBandZoomModifier,
  TextEngine,
  TooltipModifier,
  ZoomPanModifier,
  type RenderDevice,
  type SurfaceRenderTarget,
  type ThemeDocument,
  type TooltipData,
} from '@tachyon-charts/core';
import { createWebGpuDevice } from '@tachyon-charts/render-webgpu';
import { bindChartInput } from './input-binding';
import { watchPreferredTheme } from './css-theme';

/** What `<tachyon-chart>` shows: a description of the fluent API or a chart made elsewhere. */
export type ChartContent = ChartBuilder | ChartDefinition | ChartSurface;

interface Shared {
  device: Promise<RenderDevice | undefined> | undefined;
  engine: Promise<TextEngine> | undefined;
}

// All charts of a page share one device and one text engine with its glyph atlas.
const shared: Shared = { device: undefined, engine: undefined };

const style = `
:host { display: block; position: relative; min-height: 150px; contain: strict; }
canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; outline: none; touch-action: none; }
p { position: absolute; inset: 0; margin: 0; display: flex; align-items: center; justify-content: center; font: 13px sans-serif; color: #888; }
`;

/**
 * The element `<tachyon-chart>`. Give it a chart with {@link TachyonChartElement.chart}: a `ChartBuilder`, its
 * definition, or a `ChartSurface`. Attributes: `theme` (`auto` follows light and dark of the system and is the default,
 * a built-in name such as `light` or `neon`, or `none`), `interactive` (`false` switches zoom, pan, crosshair and keys
 * off). Events: `tachyon-ready` after the first frame, `tachyon-tooltip` with the point under the pointer as detail,
 * `tachyon-error` when the browser cannot draw.
 */
export class TachyonChartElement extends HTMLElement {
  /** The attributes the element follows. */
  static readonly observedAttributes = ['theme', 'interactive'];
  /** Where the default font comes from; set it before the first chart connects to serve the font elsewhere. */
  static fontUrl: string | URL = new URL('../fonts/Roboto-Regular.ttf', import.meta.url);

  private readonly canvas: HTMLCanvasElement;
  private readonly message: HTMLParagraphElement;
  private content: ChartContent | undefined;
  private chartSurface: ChartSurface | undefined;
  private readonly modifiers = new ModifierPipeline();
  private target: SurfaceRenderTarget | undefined;
  private device: RenderDevice | undefined;
  private engine: TextEngine | undefined;
  private frame = 0;
  private framesDrawn = 0;
  private pixelSize = { width: 1, height: 1 };
  private measuredRatio = 0;
  private observer: ResizeObserver | undefined;
  private cleanups: (() => void)[] = [];
  private resolveReady: () => void = () => undefined;
  /** Resolves after the first frame of a chart. */
  readonly ready: Promise<void>;

  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open' });
    const sheet = document.createElement('style');
    sheet.textContent = style;
    this.canvas = document.createElement('canvas');
    this.message = document.createElement('p');
    this.message.hidden = true;
    root.append(sheet, this.canvas, this.message);
    this.ready = new Promise((resolve) => {
      this.resolveReady = resolve;
    });
  }

  /** The chart; setting it replaces the one shown. */
  get chart(): ChartContent | undefined {
    return this.content;
  }

  set chart(value: ChartContent | undefined) {
    this.content = value;
    this.build();
  }

  /** The chart as it is drawn, once the element has its text engine; `undefined` before. */
  get surface(): ChartSurface | undefined {
    return this.chartSurface;
  }

  /** The modifiers that take the input; add or remove some to change the interaction. */
  get pipeline(): ModifierPipeline {
    return this.modifiers;
  }

  /** The number of frames drawn, for whoever waits for one. */
  get frameCount(): number {
    return this.framesDrawn;
  }

  /** Starts drawing when the element enters a page. */
  connectedCallback(): void {
    void this.start();
  }

  /** Frees the GPU resources and stops drawing when the element leaves the page; it starts again when it returns. */
  disconnectedCallback(): void {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.observer?.disconnect();
    this.observer = undefined;
    for (const cleanup of this.cleanups.splice(0)) {
      cleanup();
    }
    this.modifiers.cancelAllCaptures();
    for (const series of this.chartSurface?.series ?? []) {
      series.releaseResources();
    }
    this.target?.dispose();
    this.target = undefined;
  }

  /** Follows a change of `theme` or `interactive`. */
  attributeChangedCallback(name: string): void {
    if (name === 'theme') {
      this.applyTheme();
    } else if (this.chartSurface) {
      this.applyInteraction();
    }
  }

  private async start(): Promise<void> {
    shared.device ??= createWebGpuDevice();
    shared.engine ??= fetch(TachyonChartElement.fontUrl)
      .then((response) => response.arrayBuffer())
      .then((font) => new TextEngine(font));
    const [device, engine] = await Promise.all([shared.device, shared.engine]);
    if (!this.isConnected || this.target) {
      return;
    }
    if (!device) {
      this.message.textContent = 'This browser cannot draw with WebGPU.';
      this.message.hidden = false;
      this.dispatchEvent(new CustomEvent('tachyon-error', { detail: 'WebGPU is not available.' }));
      return;
    }
    this.device = device;
    this.engine = engine;
    this.measure();
    this.target = device.createSurfaceTarget({ kind: 'canvas', canvas: this.canvas }, this.pixelSize, devicePixelRatio);
    this.observer = new ResizeObserver((entries) => {
      this.measure(entries[0]);
    });
    try {
      this.observer.observe(this.canvas, { box: 'device-pixel-content-box' });
    } catch {
      // Browsers without that box report CSS pixels, which the pixel ratio turns into device pixels.
      this.observer.observe(this.canvas);
    }
    this.cleanups.push(bindChartInput(this.canvas, this.modifiers));
    this.build();
    this.applyTheme();
    this.frame = requestAnimationFrame(this.draw);
  }

  // The size of the canvas in device pixels, exact where the browser reports it.
  private measure(entry?: ResizeObserverEntry): void {
    // Safari has no device-pixel box; the types of the DOM claim it is always there.
    const boxes = (entry as { devicePixelContentBoxSize?: readonly ResizeObserverSize[] } | undefined)
      ?.devicePixelContentBoxSize;
    const device = boxes?.[0];
    const width = device ? device.inlineSize : Math.round(this.canvas.clientWidth * devicePixelRatio);
    const height = device ? device.blockSize : Math.round(this.canvas.clientHeight * devicePixelRatio);
    this.pixelSize = { width: Math.max(width, 1), height: Math.max(height, 1) };
    this.measuredRatio = devicePixelRatio;
  }

  private readonly draw = (): void => {
    this.frame = requestAnimationFrame(this.draw);
    const target = this.target;
    const surface = this.chartSurface;
    const device = this.device;
    if (!target || !surface || !device) {
      return;
    }
    // A new pixel ratio, such as on another screen, does not always reach the observer.
    if (devicePixelRatio !== this.measuredRatio) {
      this.measure();
    }
    const { width, height } = this.pixelSize;
    if (width !== target.size.width || height !== target.size.height || target.dpiScale !== devicePixelRatio) {
      target.resize(this.pixelSize, devicePixelRatio);
    }
    if (surface.hasChanges(target)) {
      surface.render(device, target);
      this.framesDrawn++;
      this.dataset.frames = String(this.framesDrawn);
      if (this.framesDrawn === 1) {
        this.resolveReady();
        this.dispatchEvent(new CustomEvent('tachyon-ready'));
      }
    }
  };

  private build(): void {
    const content = this.content;
    const engine = this.engine;
    if (!engine) {
      return;
    }
    for (const series of this.chartSurface?.series ?? []) {
      series.releaseResources();
    }
    if (content instanceof ChartSurface) {
      this.chartSurface = content;
    } else if (content instanceof ChartBuilder) {
      this.chartSurface = content.build(engine).surface;
    } else if (content instanceof ChartDefinition) {
      this.chartSurface = content.build(engine).surface;
    } else {
      this.chartSurface = undefined;
    }
    this.applyTheme();
    this.applyInteraction();
  }

  // The modifiers of the example and the .NET showroom, unless interactive="false".
  private applyInteraction(): void {
    this.modifiers.clear();
    const surface = this.chartSurface;
    if (!surface) {
      this.modifiers.interaction = undefined;
      return;
    }
    this.modifiers.interaction = new ChartInteraction(surface);
    if (this.getAttribute('interactive') === 'false') {
      return;
    }
    const tooltip = new TooltipModifier();
    tooltip.onChanged = (data: TooltipData | undefined) => {
      this.dispatchEvent(new CustomEvent('tachyon-tooltip', { detail: data }));
    };
    for (const modifier of [
      new ZoomPanModifier(),
      new RubberBandZoomModifier(),
      new AxisDragModifier(),
      new KeyboardNavigationModifier(),
      new CrosshairModifier(),
      tooltip,
    ]) {
      this.modifiers.add(modifier);
    }
  }

  private applyTheme(): void {
    const surface = this.chartSurface;
    const name = this.getAttribute('theme') ?? 'auto';
    const index = this.cleanups.indexOf(this.stopWatching);
    if (index >= 0) {
      this.cleanups.splice(index, 1);
      this.stopWatching();
    }
    if (!surface) {
      return;
    }
    if (name === 'auto') {
      this.stopWatching = watchPreferredTheme((theme) => {
        this.setTheme(theme);
      });
      this.cleanups.push(this.stopWatching);
    } else {
      this.setTheme(name === 'none' ? undefined : findBuiltInTheme(name));
    }
  }

  private stopWatching: () => void = () => undefined;

  private setTheme(theme: ThemeDocument | undefined): void {
    if (this.chartSurface) {
      this.chartSurface.theme = theme;
    }
    this.style.background = theme?.surface?.background ?? '';
  }
}

/** Registers `<tachyon-chart>` (or another name) once; later calls do nothing. */
export function defineTachyonChart(name = 'tachyon-chart'): void {
  if (!customElements.get(name)) {
    customElements.define(name, class extends TachyonChartElement {});
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'tachyon-chart': TachyonChartElement;
  }
}
