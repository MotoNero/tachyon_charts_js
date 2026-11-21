// The web component <tachyon-chart>: a canvas in its own shadow root that follows the size and pixel ratio of the
// element, draws a chart when it changes, takes the input of the user and frees its GPU resources when removed.
import {
  AxisDragModifier,
  canShareMemory,
  ChartBuilder,
  ChartDefinition,
  ChartInteraction,
  ChartSurface,
  CrosshairModifier,
  findBuiltInTheme,
  getResamplingWorker,
  KeyboardNavigationModifier,
  ModifierPipeline,
  RemoteRenderDevice,
  RubberBandZoomModifier,
  setResamplingWorker,
  TextEngine,
  TooltipModifier,
  ZoomPanModifier,
  type PixelSize,
  type RenderDevice,
  type SurfaceRenderTarget,
  type ThemeDocument,
  type TooltipData,
} from '@tachyon-charts/core';
import { createWebGpuDevice, createWebGpuWorkerDevice } from '@tachyon-charts/render-webgpu';
import { joinFrameLoop, leaveFrameLoop, wakeFrameLoop, type LoopMember } from './frame-loop';
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

// The data worker of the page builds the pyramids of all series from shared memory, where the page has it.
function startDataWorker(): void {
  if (!TachyonChartElement.dataWorker || !canShareMemory() || getResamplingWorker() || typeof Worker !== 'function') {
    return;
  }
  try {
    const worker = new Worker(new URL('./data-worker-entry.js', import.meta.url), { type: 'module' });
    setResamplingWorker(worker);
  } catch {
    // Without the worker the pyramids grow on this thread in slices.
  }
}

// The device of the page: WebGPU in a render worker where the browser can hand a canvas to one, else on this thread.
async function createDevice(): Promise<RenderDevice | undefined> {
  if (TachyonChartElement.renderInWorker) {
    const remote = await createWebGpuWorkerDevice();
    if (remote) {
      return remote;
    }
  }
  return createWebGpuDevice();
}

const style = `
:host { display: block; position: relative; min-height: 150px; contain: strict; }
canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; outline: none; touch-action: none; }
p { position: absolute; inset: 0; margin: 0; display: flex; align-items: center; justify-content: center; font: 13px sans-serif; color: #888; }
p[hidden] { display: none; }
`;

/**
 * The element `<tachyon-chart>`. Give it a chart with {@link TachyonChartElement.chart}: a `ChartBuilder`, its
 * definition, or a `ChartSurface`. Attributes: `theme` (`auto` follows light and dark of the system, `chart` keeps the
 * theme the chart was described with, a built-in name such as `light` or `neon`, or `none`; without the attribute the
 * theme of the chart, or `auto` for a chart without one), `interactive` (`false` switches zoom, pan, crosshair and keys
 * off). Events: `tachyon-ready` after the first frame, `tachyon-tooltip` with the point under the pointer as detail,
 * `tachyon-error` when the browser cannot draw.
 */
export class TachyonChartElement extends HTMLElement {
  /** The attributes the element follows. */
  static readonly observedAttributes = ['theme', 'interactive'];
  /** Where the default font comes from; set it before the first chart connects to serve the font elsewhere. */
  static fontUrl: string | URL = new URL('../fonts/Roboto-Regular.ttf', import.meta.url);
  /**
   * Whether charts draw in a render worker, which keeps the main thread free; where the browser cannot, they draw on
   * the main thread. Set it before the first chart connects.
   */
  static renderInWorker = true;
  /**
   * Whether a data worker builds the pyramids of the series on cross-origin isolated pages, where the values live in
   * shared memory. Set it before the first chart connects.
   */
  static dataWorker = true;

  private canvas: HTMLCanvasElement;
  private canvasTransferred = false;
  private readonly message: HTMLParagraphElement;
  private content: ChartContent | undefined;
  private chartSurface: ChartSurface | undefined;
  private readonly modifiers = new ModifierPipeline();
  private target: SurfaceRenderTarget | undefined;
  private device: RenderDevice | undefined;
  private engine: TextEngine | undefined;
  private readonly member: LoopMember = {
    draw: () => this.draw(),
    device: () => this.device,
  };
  private visible = true;
  private visibility: IntersectionObserver | undefined;
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
    wakeFrameLoop();
  }

  /** The chart as it is drawn, once the element has its text engine; `undefined` before. */
  get surface(): ChartSurface | undefined {
    return this.chartSurface;
  }

  /** The modifiers that take the input; add or remove some to change the interaction. */
  get pipeline(): ModifierPipeline {
    return this.modifiers;
  }

  /** Where the chart draws: `worker` in the render worker, `main` on the main thread, `undefined` before it starts. */
  get renderThread(): 'worker' | 'main' | undefined {
    if (!this.device) {
      return undefined;
    }
    return this.device instanceof RemoteRenderDevice ? 'worker' : 'main';
  }

  /** The size the chart is drawn in, in device pixels. */
  get drawingSize(): PixelSize {
    return this.target?.size ?? { width: 0, height: 0 };
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
    leaveFrameLoop(this.member);
    this.visibility?.disconnect();
    this.visibility = undefined;
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
    wakeFrameLoop();
    if (name === 'theme') {
      this.applyTheme();
    } else if (this.chartSurface) {
      this.applyInteraction();
    }
  }

  private async start(): Promise<void> {
    startDataWorker();
    shared.device ??= createDevice();
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
    this.target = device.createSurfaceTarget(
      { kind: 'canvas', canvas: this.surfaceCanvas(device) },
      this.pixelSize,
      devicePixelRatio,
    );
    if (device instanceof RemoteRenderDevice) {
      this.cleanups.push(
        device.onError((message) => {
          this.dispatchEvent(new CustomEvent('tachyon-error', { detail: message }));
        }),
      );
    }
    this.observer = new ResizeObserver((entries) => {
      this.measure(entries[0]);
      wakeFrameLoop();
    });
    try {
      this.observer.observe(this.canvas, { box: 'device-pixel-content-box' });
    } catch {
      // Browsers without that box report CSS pixels, which the pixel ratio turns into device pixels.
      this.observer.observe(this.canvas);
    }
    this.cleanups.push(bindChartInput(this.canvas, this.modifiers));
    // Input changes the chart at once; the loop must not wait for its next look.
    for (const type of ['pointerdown', 'pointermove', 'wheel', 'keydown', 'touchstart'] as const) {
      this.canvas.addEventListener(type, wakeFrameLoop, { passive: true });
    }
    this.build();
    this.applyTheme();
    // A chart out of view keeps its changes until it shows again; its first frame it draws anyway.
    this.visibility = new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1];
      this.visible = entry?.isIntersecting ?? true;
      wakeFrameLoop();
    });
    this.visibility.observe(this);
    joinFrameLoop(this.member);
  }

  // The canvas as the device takes it. A worker gets it as OffscreenCanvas, which a canvas can give only once, so a
  // chart that returns to the page gets a new canvas.
  private surfaceCanvas(device: RenderDevice): HTMLCanvasElement | OffscreenCanvas {
    if (!(device instanceof RemoteRenderDevice)) {
      return this.canvas;
    }
    if (this.canvasTransferred) {
      const canvas = document.createElement('canvas');
      this.canvas.replaceWith(canvas);
      this.canvas = canvas;
    }
    this.canvasTransferred = true;
    return this.canvas.transferControlToOffscreen();
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

  // One frame of the loop of the page (frame-loop.ts), which also holds back charts of a worker that is behind.
  private draw(): boolean {
    const target = this.target;
    const surface = this.chartSurface;
    const device = this.device;
    if (!target || !surface || !device || (!this.visible && this.framesDrawn > 0)) {
      return false;
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
      return true;
    }
    return false;
  }

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
    this.ownTheme = this.chartSurface?.theme;
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
    // Without the attribute a chart keeps the theme it was described with, otherwise it follows the system.
    const name = this.getAttribute('theme') ?? (this.ownTheme ? 'chart' : 'auto');
    const index = this.cleanups.indexOf(this.stopWatching);
    if (index >= 0) {
      this.cleanups.splice(index, 1);
      this.stopWatching();
    }
    if (!surface) {
      return;
    }
    if (name === 'chart') {
      this.setTheme(this.ownTheme);
    } else if (name === 'auto') {
      this.stopWatching = watchPreferredTheme((theme) => {
        this.setTheme(theme);
      });
      this.cleanups.push(this.stopWatching);
    } else {
      this.setTheme(name === 'none' ? undefined : findBuiltInTheme(name));
    }
  }

  private stopWatching: () => void = () => undefined;
  private ownTheme: ThemeDocument | undefined;

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
