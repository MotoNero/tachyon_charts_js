// The colors of the background and grid passes (ChartSurfaceStyle of the .NET version).
import type { Rgba8 } from '../render/types';

/** The colors of the background and grid passes; a theme maps its tokens to them. Alpha 0 leaves a part out. */
export interface ChartSurfaceStyle {
  readonly backgroundColor: Rgba8;
  readonly plotGradientStart: Rgba8;
  readonly plotGradientEnd: Rgba8;
  readonly borderColor: Rgba8;
  readonly majorGridColor: Rgba8;
  readonly minorGridColor: Rgba8;
  readonly bandColor: Rgba8;
}

/** The colors of a chart without a theme. */
export const defaultSurfaceStyle: ChartSurfaceStyle = Object.freeze({
  backgroundColor: { r: 24, g: 28, b: 36, a: 255 },
  plotGradientStart: { r: 32, g: 38, b: 50, a: 255 },
  plotGradientEnd: { r: 32, g: 38, b: 50, a: 255 },
  borderColor: { r: 255, g: 255, b: 255, a: 0 },
  majorGridColor: { r: 58, g: 66, b: 82, a: 255 },
  minorGridColor: { r: 255, g: 255, b: 255, a: 0 },
  bandColor: { r: 255, g: 255, b: 255, a: 0 },
});
