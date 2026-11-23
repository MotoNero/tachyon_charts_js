// The base of all series and the frame a series draws in (ChartSeries and SeriesFrame of the .NET version).
import type { Axis } from '../axes/axis';
import type { ColorAxis } from '../axes/color-axis';
import type { FoundPoint, HitTestMode } from '../hit-testing/types';
import type { DoubleRange } from '../numerics/range';
import type { LinearAxisTransform } from '../numerics/transform';
import type { CommandList } from '../render/commands';
import type { RenderDevice } from '../render/device';
import type { PixelRect, Rgba8 } from '../render/types';

/** Where a series draws in a frame: its pane in physical pixels and the mappings of its axes to pixels. */
export class SeriesFrame {
  constructor(
    /** The pane in physical pixels. */
    readonly bounds: PixelRect,
    /** The mapping of X values to pixels. */
    readonly x: LinearAxisTransform,
    /** The mapping of Y values to pixels. */
    readonly y: LinearAxisTransform,
    /** Physical pixels per device-independent unit. */
    readonly dpiScale: number,
    /** The reach of the glow of lines the theme asks for, in physical pixels; 0 for none. */
    readonly glowRadius = 0,
    /** The strength of that glow, 0..1. */
    readonly glowIntensity = 0,
  ) {}
}

/**
 * The visual representation of data in a chart. A frame calls, for every series: {@link ChartSeries.takeSnapshot},
 * {@link ChartSeries.prepareData} (work without the device, such as resampling), {@link ChartSeries.prepare} (uploads)
 * and {@link ChartSeries.draw} (commands in the series pass).
 */
export abstract class ChartSeries {
  private visible = true;
  private states = 0;
  /** The name shown in rollovers and legends. */
  name: string | undefined;

  /**
   * @param xAxis - The horizontal axis.
   * @param yAxis - The vertical axis, one of a pane.
   */
  constructor(
    /** The horizontal axis. */
    readonly xAxis: Axis,
    /** The vertical axis, one of a pane. */
    readonly yAxis: Axis,
  ) {}

  /** Whether the series is drawn. */
  get isVisible(): boolean {
    return this.visible;
  }

  set isVisible(value: boolean) {
    if (value !== this.visible) {
      this.visible = value;
      this.states++;
    }
  }

  /** Grows with changes of the state the chart keeps, such as the visibility. */
  get stateVersion(): number {
    return this.states;
  }

  /** The color that stands for this series in labels. */
  get accentColor(): Rgba8 {
    return { r: 150, g: 160, b: 175, a: 255 };
  }

  /** The color axis whose colors the series shows, for rasters such as heatmaps; undefined for other series. */
  get colorAxis(): ColorAxis | undefined {
    return undefined;
  }

  /** The range of the values the colors show, for a color axis that follows the data; undefined without values. */
  colorRange(): DoubleRange | undefined {
    return undefined;
  }

  /** Grows with every change that needs a new frame. */
  abstract get version(): number;

  /** The number of points drawn in the last frame, a diagnostic counter. */
  // A getter, not a field: series override it with their own count.
  // eslint-disable-next-line @typescript-eslint/class-literal-property-style
  get drawnPointCount(): number {
    return 0;
  }

  /**
   * The range of the data along an axis, for axes that follow the data; `undefined` without data. Called in every
   * frame, so it returns ranges the series keeps rather than new ones.
   */
  dataRange(_axis: 'x' | 'y'): DoubleRange | undefined {
    return undefined;
  }

  /**
   * The point nearest to a position in physical pixels of the frame, within `maximumDistance` pixels; `undefined` for
   * none or for series without points to find.
   */
  findPoint(
    _frame: SeriesFrame,
    _pixelX: number,
    _pixelY: number,
    _maximumDistance: number,
    _mode: HitTestMode,
  ): FoundPoint | undefined {
    return undefined;
  }

  /** Fixes the data of the coming frame. Runs for all series before anything else. */
  takeSnapshot(): void {
    // Series without data of their own have nothing to fix.
  }

  /** The work of {@link ChartSeries.prepare} that needs no device, such as resampling. */
  prepareData(_frame: SeriesFrame): void {
    // Most series do all their work in prepare.
  }

  /** Prepares the frame, for example by uploading data. No frame is open yet. */
  prepare(_device: RenderDevice, _frame: SeriesFrame): void {
    // Series without device work have nothing to prepare.
  }

  /** Frees what belongs to the device, because the chart moves to another one. */
  releaseResources(): void {
    // Series without device objects have nothing to free.
  }

  /** Draws the series in the series pass. */
  abstract draw(commands: CommandList, frame: SeriesFrame): void;
}
