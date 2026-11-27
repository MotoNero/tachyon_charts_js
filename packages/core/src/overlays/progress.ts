// What a chart shows while its data arrive: a plate with a bar in the middle of the plot while a file is written or
// opened, and the share refined in the corner while a series that starts coarse becomes exact, as RefiningOverlay of
// the .NET version.
import { DipRect } from '../layout/chart-layout';
import type { ChartSurface } from '../pipeline/chart-surface';
import type { Rgba8 } from '../render/types';
import { ChartOverlay, type OverlayCanvas } from './chart-overlay';

const margin = 8;
const barHeight = 6;
const barWidth = 240;
const padding = 12;

/**
 * Shows that a chart loads: a text in the middle of the plot and, where the share is known, a bar. Hidden once
 * {@link LoadingOverlay.hide} is called.
 */
export class LoadingOverlay extends ChartOverlay {
  private shownText: string | undefined;
  private shownShare: number | undefined;

  /**
   * Shows a text and the share done, from 0 to 1; without a share only the text.
   * @param text - What the chart waits for, such as writing or opening a file.
   * @param share - The share done; none where it is not known.
   */
  show(text: string, share?: number): void {
    const clamped = share === undefined || !Number.isFinite(share) ? undefined : Math.min(Math.max(share, 0), 1);
    // A new frame once per percent, not per call.
    const percent = clamped === undefined ? undefined : Math.floor(clamped * 100);
    const before = this.shownShare === undefined ? undefined : Math.floor(this.shownShare * 100);
    if (text !== this.shownText || percent !== before) {
      this.shownText = text;
      this.shownShare = clamped;
      this.changed();
    }
  }

  /** Hides the plate. */
  hide(): void {
    if (this.shownText !== undefined) {
      this.shownText = undefined;
      this.shownShare = undefined;
      this.changed();
    }
  }

  /** Whether the plate shows. */
  get isShown(): boolean {
    return this.shownText !== undefined;
  }

  /** {@inheritDoc ChartOverlay.draw} */
  draw(canvas: OverlayCanvas): void {
    const text = this.shownText;
    if (text === undefined) {
      return;
    }
    const share = this.shownShare;
    const label = share === undefined ? text : `${text} ${String(Math.floor(share * 100))} %`;
    const plot = canvas.layout.plotArea;
    const size = canvas.labelSize;
    const line = canvas.lineHeight(size);
    const width = Math.min(Math.max(canvas.measureWidth(label, size), barWidth) + padding * 2, plot.width);
    const height = line + padding * 2 + (share === undefined ? 0 : barHeight + padding / 2);
    const left = plot.x + (plot.width - width) / 2;
    const top = plot.y + (plot.height - height) / 2;
    const colors = canvas.colors;
    canvas.fillRectangle(new DipRect(left, top, width, height), { ...colors.background, a: 235 });
    canvas.drawRectangle(new DipRect(left, top, width, height), { ...colors.accent, a: 120 });
    const textWidth = canvas.measureWidth(label, size);
    canvas.drawText(
      label,
      Math.round(left + (width - textWidth) / 2),
      Math.round(top + padding + line * 0.8),
      size,
      colors.text,
    );
    if (share !== undefined) {
      const barTop = top + padding + line + padding / 2;
      const inner = width - padding * 2;
      canvas.fillRectangle(new DipRect(left + padding, barTop, inner, barHeight), { ...colors.accent, a: 60 });
      canvas.fillRectangle(new DipRect(left + padding, barTop, inner * share, barHeight), accentOf(colors.accent));
    }
  }
}

function accentOf(color: Rgba8): Rgba8 {
  return { ...color, a: 255 };
}

/** Shows the share refined of the series that start coarse and become exact, until all are exact. */
export class RefiningOverlay extends ChartOverlay {
  /** Writes the share; `Refining 37 %` by default. */
  format: (share: number) => string = (share) => `Refining ${String(Math.floor(share * 100))} %`;

  /** @param chart - The chart whose series are watched. */
  constructor(private readonly chart: ChartSurface) {
    super();
  }

  /** The least share refined of the visible series that refine; 1 when all are exact or none refines. */
  get progress(): number {
    let least = 1;
    for (const series of this.chart.series) {
      const share = series.isVisible ? series.refiningProgress : undefined;
      if (share !== undefined) {
        least = Math.min(least, share);
      }
    }
    return least;
  }

  /** {@inheritDoc ChartOverlay.version} */
  override get version(): number {
    // A new frame once per percent, not per frame.
    return super.version + Math.floor(this.progress * 100);
  }

  /** {@inheritDoc ChartOverlay.draw} */
  draw(canvas: OverlayCanvas): void {
    const progress = this.progress;
    if (progress >= 1) {
      return;
    }
    const plot = canvas.layout.plotArea;
    const height = canvas.lineHeight(canvas.labelSize) + 8;
    canvas.drawLabel(
      this.format(progress),
      plot.x + margin,
      plot.bottom - margin - height,
      { ...canvas.colors.background, a: 220 },
      canvas.colors.text,
    );
  }
}
