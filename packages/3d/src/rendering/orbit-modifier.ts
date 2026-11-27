// Turning, moving and zooming the camera of a scene with pointer, wheel and keys, as Orbit3DModifier of the .NET
// version, with the planes moved by their outline; picking points and handles come with their parts.
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
import type { ClipPlane3D } from '../scene/clip-plane';
import type { Point3D } from '../scene/matrix';
import type { Scene3D } from '../scene/scene';

const degreesPerUnit = 0.4;
const panPerUnit = 0.0015;
const zoomPerStep = 1.15;
const degreesPerKey = 5;
const gripReach = 8;
const probe = 0.1;

function distanceToPiece(position: Point, a: Point, b: Point): number {
  const px = b.x - a.x;
  const py = b.y - a.y;
  const square = px * px + py * py;
  const share = square > 0 ? Math.min(Math.max(((position.x - a.x) * px + (position.y - a.y) * py) / square, 0), 1) : 0;
  return Math.hypot(position.x - (a.x + px * share), position.y - (a.y + py * share));
}

/**
 * Turns the camera of a scene: drag to turn, drag with Shift or the middle button to move, wheel and + and − to zoom,
 * arrows to turn, Home or a double click for the first view.
 */
export class Orbit3DModifier extends ChartModifier {
  private isDragging = false;
  private isPanning = false;
  private last: Point = { x: 0, y: 0 };
  private plane: ClipPlane3D | undefined;

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
      if (this.plane) {
        this.movePlane(this.plane, delta);
      } else if (this.isPanning) {
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
    this.plane = input.changedButton === 'primary' ? this.findPlane(input.position) : undefined;
    return 'capture';
  }

  // The plane whose outline lies nearest to the pointer, within a few units.
  private findPlane(position: Point): ClipPlane3D | undefined {
    const pane = this.interaction?.chart.currentLayout?.panes[0];
    if (!pane || this.scene.planes.length === 0) {
      return undefined;
    }
    const matrix = this.scene.camera.createMatrix(pane.width / pane.height);
    const toDips = (point: Point3D): Point => {
      const { x, y } = matrix.project(point);
      return { x: pane.x + ((x + 1) / 2) * pane.width, y: pane.y + ((1 - y) / 2) * pane.height };
    };
    let found: ClipPlane3D | undefined;
    let best = gripReach;
    for (const plane of this.scene.planes) {
      const corners = plane.outline();
      corners.forEach((corner, i) => {
        const distance = distanceToPiece(
          position,
          toDips(corner),
          toDips(corners[(i + 1) % corners.length] as Point3D),
        );
        if (distance < best) {
          found = plane;
          best = distance;
        }
      });
    }
    return found;
  }

  // Moves a plane along its normal as far as the pointer moved along the normal on the screen.
  private movePlane(plane: ClipPlane3D, way: Point): void {
    const pane = this.interaction?.chart.currentLayout?.panes[0];
    if (!pane) {
      return;
    }
    const matrix = this.scene.camera.createMatrix(pane.width / pane.height);
    const place = plane.normal.times(plane.offset);
    const a = matrix.project(place);
    const b = matrix.project(place.plus(plane.normal.times(probe)));
    const stepX = ((b.x - a.x) / 2) * pane.width;
    const stepY = ((a.y - b.y) / 2) * pane.height;
    const square = stepX * stepX + stepY * stepY;
    if (square >= 1) {
      plane.offset += ((way.x * stepX + way.y * stepY) / square) * probe;
    }
  }

  private redraw(): void {
    const interaction = this.interaction;
    interaction?.run(() => {
      interaction.chart.invalidate();
    });
  }
}
