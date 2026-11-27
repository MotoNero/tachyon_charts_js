// Turning, moving and zooming the camera of a scene with pointer, wheel and keys, as Orbit3DModifier of the .NET
// version, with the planes moved by their outline and the editors of volumes; picking points comes with its part.
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
import { Waterfall3D } from '../scene/waterfall';
import { isPieSlice, type PointerPick3D } from './pick-labels';
import type { TransferFunction3D } from '../scene/transfer';
import type { Volume3D } from '../scene/volume';
import { editorArea, editorPlace } from './scene-state';

const degreesPerUnit = 0.4;
const panPerUnit = 0.0015;
const zoomPerStep = 1.15;
const degreesPerKey = 5;
const gripReach = 8;
const probe = 0.1;
const handleReach = 9;
const clickReach = 4;
const markerReach = 10;
const spectrumReach = 0.015;

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
  private pressed: Point = { x: 0, y: 0 };
  private isClick = false;
  private plane: ClipPlane3D | undefined;
  private handle: { readonly transfer: TransferFunction3D; readonly index: number } | undefined;
  private level: Volume3D | undefined;

  /**
   * @param scene - The scene whose camera moves.
   * @param pointer - What lies under the pointer; without it there are no values and markers.
   */
  constructor(
    private readonly scene: Scene3D,
    private readonly pointer?: PointerPick3D,
  ) {
    super(ZoomPanModifier.defaultPriority);
  }

  /** {@inheritDoc @tachyon-charts/core#ChartModifier.onPointer} */
  override onPointer(input: PointerInputEvent): ModifierResult {
    if (input.kind === 'pressed' && (input.changedButton === 'primary' || input.changedButton === 'middle')) {
      return this.press(input);
    }
    if (!this.isDragging) {
      this.hover(input);
      return 'ignored';
    }
    if (input.kind === 'moved') {
      this.isClick &&= Math.hypot(input.position.x - this.pressed.x, input.position.y - this.pressed.y) <= clickReach;
      if (this.isClick) {
        return 'handled';
      }
      const delta = { x: input.position.x - this.last.x, y: input.position.y - this.last.y };
      this.last = input.position;
      const pane = this.interaction?.chart.currentLayout?.panes[0];
      if (this.level && pane) {
        const area = editorArea(pane);
        this.level.isoShare = (input.position.x - area.x) / area.width;
      } else if (this.handle && pane) {
        const area = editorArea(pane);
        this.handle.transfer.move(
          this.handle.index,
          (input.position.x - area.x) / area.width,
          1 - (input.position.y - area.y) / area.height,
        );
      } else if (this.plane) {
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
      if (input.kind === 'released' && this.isClick) {
        this.click(input.position);
      }
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
      case 'Delete':
        this.removeNewestMarker();
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
    this.pressed = input.position;
    const isPrimary = input.changedButton === 'primary';
    this.handle = isPrimary ? this.findHandle(input.position) : undefined;
    this.level = isPrimary && !this.handle ? this.findLevel(input.position) : undefined;
    this.plane = isPrimary && !this.handle && !this.level ? this.findPlane(input.position) : undefined;
    this.isClick = isPrimary && !this.isPanning && !this.plane && !this.handle && !this.level;
    this.pointer?.hide();
    return 'capture';
  }

  // The newest marker goes: of the scene first, then of a spectrum behind a waterfall.
  private removeNewestMarker(): void {
    if (this.scene.markers.length > 0) {
      this.scene.removeLastMarker();
      return;
    }
    for (const waterfall of this.scene.waterfalls) {
      const extra = waterfall.display?.extraMarkers;
      if (waterfall.display && extra && extra.length > 0) {
        waterfall.display.removeMarker(extra[extra.length - 1] as number, 0);
        return;
      }
    }
  }

  // The value under the pointer, or none once it leaves.
  private hover(input: PointerInputEvent): void {
    const pane = this.interaction?.chart.currentLayout?.panes[0];
    if (!this.pointer || !pane) {
      return;
    }
    if (input.kind === 'moved') {
      this.pointer.move(pane, input.position.x, input.position.y);
      this.redraw();
    } else if (input.kind === 'exited' || input.kind === 'canceled') {
      this.pointer.hide();
      this.redraw();
    }
  }

  // A click on a slice of a pie pulls it out or back, as in 2D; elsewhere it sets a marker, or removes the one it meets.
  // On a waterfall of a spectrum the marker belongs to the spectrum.
  private click(position: Point): void {
    const pane = this.interaction?.chart.currentLayout?.panes[0];
    const pointer = this.pointer;
    if (!pointer || !pane) {
      return;
    }
    pointer.move(pane, position.x, position.y);
    const pick = pointer.current;
    const scene = this.scene;
    if (pick && isPieSlice(pick.source)) {
      const pie = pick.source.pie;
      pie.explodedIndex = pie.explodedIndex === pick.source.index ? -1 : pick.source.index;
      this.redraw();
      return;
    }
    const nearest = this.findMarker(pane, position);
    if (pick && pick.source instanceof Waterfall3D && pick.source.display) {
      const display = pick.source.display;
      const range = scene.xAxis.visibleRange;
      if (!display.removeMarker(pick.position.x, spectrumReach * Math.abs(range.max - range.min))) {
        display.addMarker(pick.position.x);
      }
    } else if (nearest !== undefined) {
      scene.removeMarker(nearest);
    } else if (pick) {
      scene.addMarker(pick);
    } else {
      return;
    }
    this.redraw();
  }

  // The marker of the scene that lies under a point of the picture.
  private findMarker(
    pane: { x: number; y: number; width: number; height: number },
    position: Point,
  ): number | undefined {
    const matrix = this.scene.camera.createMatrix(pane.width / pane.height);
    let nearest: number | undefined;
    let best = markerReach;
    this.scene.markers.forEach((marker, i) => {
      const { x, y } = matrix.project(marker.box);
      const distance = Math.hypot(
        pane.x + ((x + 1) / 2) * pane.width - position.x,
        pane.y + ((1 - y) / 2) * pane.height - position.y,
      );
      if (distance <= best) {
        nearest = i;
        best = distance;
      }
    });
    return nearest;
  }

  // A point of the editor of a transfer function within reach of the pointer.
  private findHandle(position: Point): { transfer: TransferFunction3D; index: number } | undefined {
    const pane = this.interaction?.chart.currentLayout?.panes[0];
    if (!pane) {
      return undefined;
    }
    const area = editorArea(pane);
    for (const volume of this.scene.volumes) {
      const transfer = volume.transfer;
      if (!transfer?.showsEditor) {
        continue;
      }
      const index = transfer.points.findIndex((point) => {
        const place = editorPlace(area, point);
        return Math.hypot(position.x - place.x, position.y - place.y) <= handleReach;
      });
      if (index >= 0) {
        return { transfer, index };
      }
    }
    return undefined;
  }

  // The slider of a surface within reach of the pointer.
  private findLevel(position: Point): Volume3D | undefined {
    const pane = this.interaction?.chart.currentLayout?.panes[0];
    if (!pane) {
      return undefined;
    }
    const area = editorArea(pane);
    return this.scene.volumes.find((volume) => {
      const x = area.x + volume.isoShare * area.width;
      return (
        volume.mode === 'surface' &&
        volume.showsEditor &&
        Math.abs(position.x - x) <= handleReach &&
        position.y >= area.y - handleReach &&
        position.y <= area.y + area.height + handleReach
      );
    });
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
