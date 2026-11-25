// Turning, moving and zooming the camera of a scene with pointer, wheel and keys, as Orbit3DModifier of the .NET
// version; picking points, planes and handles come with their parts.
import {
  ChartModifier,
  InputModifiers,
  ZoomPanModifier,
  type KeyInputEvent,
  type ModifierResult,
  type Point,
  type PointerInputEvent,
  type WheelInputEvent,
} from '@tachyon-charts/core';
import type { Scene3D } from '../scene/scene';

const degreesPerUnit = 0.4;
const panPerUnit = 0.0015;
const zoomPerStep = 1.15;
const degreesPerKey = 5;

/**
 * Turns the camera of a scene: drag to turn, drag with Shift or the middle button to move, wheel and + and − to zoom,
 * arrows to turn, Home or a double click for the first view.
 */
export class Orbit3DModifier extends ChartModifier {
  private isDragging = false;
  private isPanning = false;
  private last: Point = { x: 0, y: 0 };

  /** @param scene - The scene whose camera moves. */
  constructor(private readonly scene: Scene3D) {
    super(ZoomPanModifier.defaultPriority);
  }

  /** {@inheritDoc @tachyon-charts/core#ChartModifier.onPointer} */
  override onPointer(input: PointerInputEvent): ModifierResult {
    if (input.kind === 'pressed' && (input.changedButton === 'primary' || input.changedButton === 'middle')) {
      return this.press(input);
    }
    if (!this.isDragging) {
      return 'ignored';
    }
    if (input.kind === 'moved') {
      const delta = { x: input.position.x - this.last.x, y: input.position.y - this.last.y };
      this.last = input.position;
      if (this.isPanning) {
        this.scene.camera.pan(-delta.x * panPerUnit, delta.y * panPerUnit);
      } else {
        this.scene.camera.orbit(-delta.x * degreesPerUnit, delta.y * degreesPerUnit);
      }
      this.redraw();
      return 'handled';
    }
    if (input.kind === 'released' || input.kind === 'canceled') {
      this.isDragging = false;
      return 'release';
    }
    return 'ignored';
  }

  /** {@inheritDoc @tachyon-charts/core#ChartModifier.onWheel} */
  override onWheel(input: WheelInputEvent): ModifierResult {
    if (input.delta.y === 0) {
      return 'ignored';
    }
    this.scene.camera.zoom(input.delta.y > 0 ? 1 / zoomPerStep : zoomPerStep);
    this.redraw();
    return 'handled';
  }

  /** {@inheritDoc @tachyon-charts/core#ChartModifier.onKey} */
  override onKey(input: KeyInputEvent): ModifierResult {
    if (input.kind !== 'pressed') {
      return 'ignored';
    }
    const camera = this.scene.camera;
    switch (input.key) {
      case 'Left':
        camera.orbit(degreesPerKey, 0);
        break;
      case 'Right':
        camera.orbit(-degreesPerKey, 0);
        break;
      case 'Up':
        camera.orbit(0, degreesPerKey);
        break;
      case 'Down':
        camera.orbit(0, -degreesPerKey);
        break;
      case 'Add':
        camera.zoom(1 / zoomPerStep);
        break;
      case 'Subtract':
        camera.zoom(zoomPerStep);
        break;
      case 'Home':
        camera.show('default');
        break;
      default:
        return 'ignored';
    }
    this.redraw();
    return 'handled';
  }

  /** {@inheritDoc @tachyon-charts/core#ChartModifier.onCaptureLost} */
  override onCaptureLost(): void {
    this.isDragging = false;
  }

  private press(input: PointerInputEvent): ModifierResult {
    if (input.clickCount >= 2) {
      this.scene.camera.show('default');
      this.redraw();
      return 'handled';
    }
    this.isDragging = true;
    this.isPanning = input.changedButton === 'middle' || (input.modifiers & InputModifiers.shift) !== 0;
    this.last = input.position;
    return 'capture';
  }

  private redraw(): void {
    const interaction = this.interaction;
    interaction?.run(() => {
      interaction.chart.invalidate();
    });
  }
}
