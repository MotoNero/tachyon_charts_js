// What a scene still waits for, over the picture: the progress of a cloud that is on its way, as DrawProgress of
// PointerPick3D in the .NET version.
import { chartText, ChartOverlay, DipRect, roundHalfEven, type OverlayCanvas } from '@tachyon-charts/core';
import type { Scene3D } from '../scene/scene';

const barWidth = 220;
const barHeight = 4;
const barTop = 44;

/** @internal Shows the progress of the first cloud on its way. */
export class SceneState3D extends ChartOverlay {
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
    const cloud = this.scene.clouds.find((item) => item.showsProgress);
    if (!pane || !cloud) {
      return;
    }
    const progress = cloud.progress;
    const x = pane.x + (pane.width - barWidth) / 2;
    const y = pane.y + barTop;
    const text = `${chartText.text('loading')} ${String(Math.trunc(progress * 100))} %`;
    canvas.drawText(text, roundHalfEven(x), roundHalfEven(y - 6), canvas.labelSize, canvas.colors.text);
    const bar = new DipRect(x, y, barWidth, barHeight);
    canvas.fillRectangle(bar, canvas.colors.background);
    canvas.drawRectangle(bar, canvas.colors.text);
    canvas.fillRectangle(new DipRect(x, y, barWidth * progress, barHeight), canvas.colors.accent);
  }
}
