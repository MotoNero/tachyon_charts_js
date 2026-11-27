// What a scene still waits for and the small editors of its volumes, over the picture: the progress of a cloud or a
// volume on its way, how a volume fits on the graphics card, the slider of a surface and the editor of a transfer
// function, as DrawProgress, DrawVolumeState, DrawLevel and DrawEditor of PointerPick3D in the .NET version.
import {
  chartText,
  ChartOverlay,
  DipRect,
  formatGeneral,
  roundHalfEven,
  type OverlayCanvas,
  type Point,
  type SpectrumDisplay,
} from '@tachyon-charts/core';
import { BoxMap } from '../scene/points';
import type { Scene3D } from '../scene/scene';
import { markerColor, markerFrequencies, markerTop } from '../scene/spectrum-links';
import type { TransferFunction3D, TransferPoint3D } from '../scene/transfer';
import { describeGpuFit, type Volume3D } from '../scene/volume';

const barWidth = 220;
const barHeight = 4;
const barTop = 44;
const editorWidth = 180;
const editorHeight = 84;
const editorMargin = 14;
const handle = 4;
const editorSteps = 64;

/** @internal The area of the editor of a volume in the corner of the plot. */
export function editorArea(pane: DipRect): DipRect {
  return new DipRect(
    pane.x + pane.width - editorWidth - editorMargin,
    pane.y + editorMargin,
    editorWidth,
    editorHeight,
  );
}

/** @internal The place of a point of a transfer function in its editor. */
export function editorPlace(area: DipRect, point: TransferPoint3D): Point {
  return {
    x: Math.fround(area.x + point.share * area.width),
    y: Math.fround(area.y + (1 - point.opacity) * area.height),
  };
}

function drawProgress(canvas: OverlayCanvas, pane: DipRect, progress: number): void {
  const x = pane.x + (pane.width - barWidth) / 2;
  const y = pane.y + barTop;
  const text = `${chartText.text('loading')} ${String(Math.trunc(progress * 100))} %`;
  canvas.drawText(text, roundHalfEven(x), roundHalfEven(y - 6), canvas.labelSize, canvas.colors.text);
  const bar = new DipRect(x, y, barWidth, barHeight);
  canvas.fillRectangle(bar, canvas.colors.background);
  canvas.drawRectangle(bar, canvas.colors.text);
  canvas.fillRectangle(new DipRect(x, y, barWidth * progress, barHeight), canvas.colors.accent);
}

// A colored bar across the value range with the slider at the value of the surface.
function drawLevel(canvas: OverlayCanvas, area: DipRect, volume: Volume3D): void {
  const columns = 64;
  const height = 14;
  const bar = new DipRect(area.x, area.y + (area.height - height) / 2, area.width, height);
  const width = bar.width / columns;
  for (let i = 0; i < columns; i++) {
    canvas.fillRectangle(
      new DipRect(bar.x + i * width, bar.y, width + 0.5, bar.height),
      volume.colormap.sample((i + 0.5) / columns),
    );
  }
  canvas.drawRectangle(bar, canvas.colors.text);
  const x = Math.fround(bar.x + volume.isoShare * bar.width);
  canvas.drawLine(
    { x, y: Math.fround(bar.y - 6) },
    { x, y: Math.fround(bar.y + bar.height + 6) },
    4,
    canvas.colors.text,
  );
  const text = formatGeneral(volume.isoValue, 6, chartText.culture);
  canvas.drawText(
    text,
    roundHalfEven(x - canvas.measureWidth(text, canvas.labelSize) / 2),
    roundHalfEven(bar.y + bar.height + 22),
    canvas.labelSize,
    canvas.colors.text,
  );
}

/** @internal Shows the progress of clouds and volumes and the editors of volumes. */
export class SceneState3D extends ChartOverlay {
  // The editor shows 64 steps of the function, coarser than the table of the GPU.
  private readonly table = new Float32Array(editorSteps * 4);

  constructor(private readonly scene: Scene3D) {
    super();
  }

  /** {@inheritDoc ChartOverlay.version} */
  override get version(): number {
    return super.version + this.scene.version + chartText.version;
  }

  /** {@inheritDoc ChartOverlay.draw} */
  draw(canvas: OverlayCanvas): void {
    const pane = canvas.layout.panes[0];
    if (!pane) {
      return;
    }
    this.drawSpectrumMarkers(canvas, pane);
    const cloud = this.scene.clouds.find((item) => item.showsProgress);
    if (cloud) {
      drawProgress(canvas, pane, cloud.progress);
    }
    this.drawVolumeState(canvas, pane);
    for (const volume of this.scene.volumes) {
      if (volume.mode === 'surface' && volume.showsEditor) {
        drawLevel(canvas, editorArea(pane), volume);
        break;
      }
      if (volume.transfer?.showsEditor) {
        this.drawEditor(canvas, editorArea(pane), volume.transfer);
        break;
      }
    }
  }

  // The markers of a spectrum behind a waterfall carry the numbers of the 2D chart at the top of their posts.
  private drawSpectrumMarkers(canvas: OverlayCanvas, pane: DipRect): void {
    const scene = this.scene;
    const waterfalls = scene.waterfalls.filter((waterfall) => waterfall.display !== undefined);
    if (waterfalls.length === 0) {
      return;
    }
    const map = new BoxMap(scene.xAxis, scene.yAxis, scene.zAxis);
    const matrix = scene.camera.createMatrix(pane.width / pane.height);
    for (const waterfall of waterfalls) {
      const display = waterfall.display as SpectrumDisplay;
      markerFrequencies(display).forEach((frequency, i) => {
        const box = map.toBox(markerTop(waterfall, display, frequency));
        if (Math.abs(box.x) <= 1) {
          const { x, y } = matrix.project(box.withZ(Math.min(Math.max(box.z, -1), 1)));
          const dipX = pane.x + ((x + 1) / 2) * pane.width;
          const dipY = pane.y + ((1 - y) / 2) * pane.height;
          canvas.drawText(
            String(i + 1),
            roundHalfEven(dipX - 10),
            roundHalfEven(dipY - 6),
            canvas.labelSize,
            markerColor,
          );
        }
      });
    }
  }

  // How far a volume has reached the GPU, and a line when the graphics card could not take it in full.
  private drawVolumeState(canvas: OverlayCanvas, pane: DipRect): void {
    for (const volume of this.scene.volumes) {
      const fit = volume.gpuFit;
      if (fit && (fit.reduction > 1 || !fit.isExact)) {
        const message = describeGpuFit(fit);
        const width = canvas.measureWidth(message, canvas.labelSize);
        canvas.drawText(
          message,
          roundHalfEven(pane.x + (pane.width - width) / 2),
          roundHalfEven(pane.y + 20),
          canvas.labelSize,
          canvas.colors.text,
        );
      }
      if (!volume.isReady) {
        drawProgress(canvas, pane, volume.progress);
        return;
      }
    }
  }

  private drawEditor(canvas: OverlayCanvas, area: DipRect, transfer: TransferFunction3D): void {
    const table = this.table;
    transfer.writeTable(table);
    canvas.fillRectangle(area, canvas.colors.background);
    const count = editorSteps;
    const width = area.width / count;
    for (let i = 0; i < count; i++) {
      const height = area.height * (table[i * 4 + 3] as number);
      const shade = {
        r: Math.trunc(Math.fround((table[i * 4] as number) * 255)),
        g: Math.trunc(Math.fround((table[i * 4 + 1] as number) * 255)),
        b: Math.trunc(Math.fround((table[i * 4 + 2] as number) * 255)),
        a: 255,
      };
      canvas.fillRectangle(new DipRect(area.x + i * width, area.y + area.height - height, width + 0.5, height), shade);
    }
    canvas.drawRectangle(area, canvas.colors.text);
    const points = transfer.points;
    points.forEach((point, i) => {
      const place = editorPlace(area, point);
      canvas.drawLine(
        { x: place.x - handle, y: place.y },
        { x: place.x + handle, y: place.y },
        2 * handle,
        canvas.colors.text,
      );
      if (i > 0) {
        canvas.drawLine(editorPlace(area, points[i - 1] as TransferPoint3D), place, 1.5, canvas.colors.text);
      }
    });
  }
}
