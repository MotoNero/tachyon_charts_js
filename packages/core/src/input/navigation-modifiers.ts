// Navigation with pointer, wheel, gestures and keys (NavigationModifiers and KeyboardNavigationModifier of the .NET
// version).
import { DipRect, type AxisPlacement } from '../layout/chart-layout';
import type { ChartDirection, PaneHit } from './chart-interaction';
import { ChartModifier, type ModifierResult } from './modifier-pipeline';
import {
  InputModifiers,
  matchesKey,
  type GestureInputEvent,
  type KeyBinding,
  type KeyInputEvent,
  type Point,
  type PointerButton,
  type PointerInputEvent,
  type WheelInputEvent,
} from './primitives';

/**
 * Zooms with the wheel around the cursor, pans by dragging, and follows pan and pinch gestures. A double click lets the
 * axes of the pane follow the data again.
 */
export class ZoomPanModifier extends ChartModifier {
  /** The priority of this modifier unless another is given. */
  static readonly defaultPriority = 10;
  /** The directions the wheel and pinches zoom. */
  zoomDirection: ChartDirection = 'both';
  /** The directions dragging pans. */
  panDirection: ChartDirection = 'both';
  /** The factor of one notch of the wheel. */
  zoomStep = 1.2;
  /** The button that pans. */
  panButton: PointerButton = 'primary';
  private pane: PaneHit | undefined;
  private last: Point = { x: 0, y: 0 };
  private pointerId = 0;
  private isPanning = false;

  constructor() {
    super(ZoomPanModifier.defaultPriority);
  }

  /** {@inheritDoc ChartModifier.onWheel} */
  override onWheel(input: WheelInputEvent): ModifierResult {
    const interaction = this.interaction;
    const pane = interaction?.hitPane(input.position);
    if (!interaction || input.delta.y === 0 || !pane) {
      return 'ignored';
    }
    interaction.zoom(pane, input.position, this.zoomStep ** -input.delta.y, this.zoomDirection);
    return 'handled';
  }

  /** {@inheritDoc ChartModifier.onPointer} */
  override onPointer(input: PointerInputEvent): ModifierResult {
    if (this.isPanning) {
      return input.pointerId === this.pointerId ? this.continuePan(input) : 'ignored';
    }
    const interaction = this.interaction;
    if (
      input.kind !== 'pressed' ||
      input.changedButton !== this.panButton ||
      input.modifiers !== InputModifiers.none ||
      !interaction
    ) {
      return 'ignored';
    }
    const pane = interaction.hitPane(input.position);
    if (!pane) {
      return 'ignored';
    }
    if (input.clickCount >= 2) {
      interaction.autoRangePane(pane);
      return 'handled';
    }
    this.pane = pane;
    this.isPanning = true;
    this.pointerId = input.pointerId;
    this.last = input.position;
    return 'capture';
  }

  /** {@inheritDoc ChartModifier.onGesture} */
  override onGesture(input: GestureInputEvent): ModifierResult {
    const interaction = this.interaction;
    const pane = interaction?.hitPane(input.position);
    if (!interaction || !pane) {
      return 'ignored';
    }
    if (input.kind === 'pan' && (input.delta.x !== 0 || input.delta.y !== 0)) {
      interaction.pan(pane, input.delta, this.panDirection);
    } else if (input.kind === 'pinch' && input.scale > 0 && input.scale !== 1) {
      interaction.zoom(pane, input.position, 1 / input.scale, this.zoomDirection);
    }
    return 'handled';
  }

  /** {@inheritDoc ChartModifier.onCaptureLost} */
  override onCaptureLost(): void {
    this.isPanning = false;
  }

  private continuePan(input: PointerInputEvent): ModifierResult {
    switch (input.kind) {
      case 'moved':
        if (this.pane) {
          this.interaction?.pan(
            this.pane,
            { x: input.position.x - this.last.x, y: input.position.y - this.last.y },
            this.panDirection,
          );
        }
        this.last = input.position;
        return 'handled';
      case 'released':
      case 'canceled':
        this.isPanning = false;
        return 'release';
      default:
        return 'handled';
    }
  }
}

/** Zooms into a dragged rectangle. Limits of the axes apply, and Escape cancels the drag. */
export class RubberBandZoomModifier extends ChartModifier {
  /** The priority of this modifier unless another is given. */
  static readonly defaultPriority = 20;
  /** The directions the rectangle zooms. */
  direction: ChartDirection = 'both';
  /** The {@link InputModifiers} that must be held to start the rectangle; control by default. */
  modifierKey: number = InputModifiers.control;
  /** The button that drags. */
  button: PointerButton = 'primary';
  /** The smallest width and height in device-independent units that zoom. */
  minimumExtent = 4;
  private pane: PaneHit | undefined;
  private start: Point = { x: 0, y: 0 };
  private pointerId = 0;
  private isDragging = false;
  private isCanceled = false;

  constructor() {
    super(RubberBandZoomModifier.defaultPriority);
  }

  /** {@inheritDoc ChartModifier.onPointer} */
  override onPointer(input: PointerInputEvent): ModifierResult {
    if (this.isDragging) {
      return input.pointerId === this.pointerId ? this.continueDrag(input) : 'ignored';
    }
    const pane = this.interaction?.hitPane(input.position);
    if (
      input.kind !== 'pressed' ||
      input.changedButton !== this.button ||
      input.modifiers !== this.modifierKey ||
      !pane
    ) {
      return 'ignored';
    }
    this.pane = pane;
    this.isDragging = true;
    this.isCanceled = false;
    this.pointerId = input.pointerId;
    this.start = input.position;
    return 'capture';
  }

  /** {@inheritDoc ChartModifier.onKey} */
  override onKey(input: KeyInputEvent): ModifierResult {
    if (this.isDragging && !this.isCanceled && input.key === 'Escape' && input.kind === 'pressed') {
      this.isCanceled = true;
      this.interaction?.showZoomRectangle(undefined);
      return 'handled';
    }
    return 'ignored';
  }

  /** {@inheritDoc ChartModifier.onCaptureLost} */
  override onCaptureLost(): void {
    this.isDragging = false;
    this.interaction?.showZoomRectangle(undefined);
  }

  private continueDrag(input: PointerInputEvent): ModifierResult {
    switch (input.kind) {
      case 'moved':
        if (!this.isCanceled) {
          this.interaction?.showZoomRectangle(this.areaTo(input.position));
        }
        return 'handled';
      case 'released':
        this.finish(this.areaTo(input.position));
        return 'release';
      case 'canceled':
        this.isCanceled = true;
        this.finish(DipRect.empty);
        return 'release';
      default:
        return 'handled';
    }
  }

  private finish(area: DipRect): void {
    this.isDragging = false;
    const interaction = this.interaction;
    if (!interaction || !this.pane) {
      return;
    }
    interaction.showZoomRectangle(undefined);
    const isWideEnough = this.direction === 'y' || area.width >= this.minimumExtent;
    const isHighEnough = this.direction === 'x' || area.height >= this.minimumExtent;
    if (!this.isCanceled && isWideEnough && isHighEnough) {
      interaction.zoomTo(this.pane, area, this.direction);
    }
  }

  // The rectangle stays inside the pane where the drag began.
  private areaTo(position: Point): DipRect {
    const pane = (this.pane as PaneHit).bounds;
    const x = Math.min(Math.max(position.x, pane.x), pane.right);
    const y = Math.min(Math.max(position.y, pane.y), pane.bottom);
    const alongX = this.direction !== 'y';
    const alongY = this.direction !== 'x';
    const left = alongX ? Math.min(this.start.x, x) : pane.x;
    const right = alongX ? Math.max(this.start.x, x) : pane.right;
    const top = alongY ? Math.min(this.start.y, y) : pane.y;
    const bottom = alongY ? Math.max(this.start.y, y) : pane.bottom;
    return new DipRect(left, top, right - left, bottom - top);
  }
}

const scaleSpeed = 0.01;

/**
 * Acts on a single axis: dragging pans it, dragging with the scale key or the wheel scales it, and a double click lets
 * it follow the data again.
 */
export class AxisDragModifier extends ChartModifier {
  /** The priority of this modifier unless another is given. */
  static readonly defaultPriority = 30;
  /** The {@link InputModifiers} that make dragging scale instead of pan; shift by default. */
  scaleKey: number = InputModifiers.shift;
  /** The factor of one notch of the wheel. */
  zoomStep = 1.2;
  private axis: AxisPlacement | undefined;
  private start: Point = { x: 0, y: 0 };
  private last: Point = { x: 0, y: 0 };
  private pointerId = 0;
  private isDragging = false;

  constructor() {
    super(AxisDragModifier.defaultPriority);
  }

  /** {@inheritDoc ChartModifier.onPointer} */
  override onPointer(input: PointerInputEvent): ModifierResult {
    if (this.isDragging) {
      return input.pointerId === this.pointerId ? this.continueDrag(input) : 'ignored';
    }
    const interaction = this.interaction;
    const hit = interaction?.hitAxis(input.position);
    if (input.kind !== 'pressed' || input.changedButton !== 'primary' || !interaction || !hit) {
      return 'ignored';
    }
    if (input.clickCount >= 2) {
      interaction.autoRange(hit.axis);
      return 'handled';
    }
    this.axis = hit;
    this.isDragging = true;
    this.pointerId = input.pointerId;
    this.start = input.position;
    this.last = input.position;
    return 'capture';
  }

  /** {@inheritDoc ChartModifier.onWheel} */
  override onWheel(input: WheelInputEvent): ModifierResult {
    const interaction = this.interaction;
    const hit = interaction?.hitAxis(input.position);
    if (!interaction || input.delta.y === 0 || !hit) {
      return 'ignored';
    }
    const position = hit.axis.isHorizontal ? input.position.x : input.position.y;
    interaction.zoomAxis(hit, position, this.zoomStep ** -input.delta.y);
    return 'handled';
  }

  /** {@inheritDoc ChartModifier.onCaptureLost} */
  override onCaptureLost(): void {
    this.isDragging = false;
  }

  private continueDrag(input: PointerInputEvent): ModifierResult {
    switch (input.kind) {
      case 'moved':
        this.drag(input);
        return 'handled';
      case 'released':
      case 'canceled':
        this.isDragging = false;
        return 'release';
      default:
        return 'handled';
    }
  }

  private drag(input: PointerInputEvent): void {
    const delta = { x: input.position.x - this.last.x, y: input.position.y - this.last.y };
    this.last = input.position;
    const interaction = this.interaction;
    const placement = this.axis;
    if (!interaction || !placement) {
      return;
    }
    const isHorizontal = placement.axis.isHorizontal;
    const distance = isHorizontal ? delta.x : delta.y;
    if (this.scaleKey !== InputModifiers.none && (input.modifiers & this.scaleKey) === this.scaleKey) {
      // Towards larger values zooms in, on both kinds of axis.
      const growth = isHorizontal ? distance : -distance;
      interaction.zoomAxis(placement, isHorizontal ? this.start.x : this.start.y, Math.exp(-growth * scaleSpeed));
    } else {
      interaction.panAxis(placement, distance);
    }
  }
}

/** What a key of the keyboard navigation does. */
export type ChartKeyAction =
  'panLeft' | 'panRight' | 'panUp' | 'panDown' | 'zoomIn' | 'zoomOut' | 'autoRange' | 'undo' | 'redo';

/** Navigates with the keyboard; the keys can be changed in {@link KeyboardNavigationModifier.bindings}. */
export class KeyboardNavigationModifier extends ChartModifier {
  /** The key of each action. */
  readonly bindings = new Map<ChartKeyAction, KeyBinding>([
    ['panLeft', { key: 'Left' }],
    ['panRight', { key: 'Right' }],
    ['panUp', { key: 'Up' }],
    ['panDown', { key: 'Down' }],
    ['zoomIn', { key: 'Add' }],
    ['zoomOut', { key: 'Subtract' }],
    ['autoRange', { key: 'Home' }],
    ['undo', { key: 'Z', modifiers: InputModifiers.control }],
    ['redo', { key: 'Y', modifiers: InputModifiers.control }],
  ]);
  /** The share of the plot one key press pans. */
  panStep = 0.1;
  /** The factor one key press zooms. */
  zoomStep = 1.2;

  constructor() {
    super(5);
  }

  /** {@inheritDoc ChartModifier.onKey} */
  override onKey(input: KeyInputEvent): ModifierResult {
    const interaction = this.interaction;
    const layout = interaction?.chart.currentLayout;
    if (!interaction || !layout) {
      return 'ignored';
    }
    for (const [action, binding] of this.bindings) {
      if (matchesKey(binding, input)) {
        const plot = layout.plotArea;
        this.perform(action, { x: plot.x + plot.width / 2, y: plot.y + plot.height / 2 }, plot.width, plot.height);
        return 'handled';
      }
    }
    return 'ignored';
  }

  private perform(action: ChartKeyAction, center: Point, width: number, height: number): void {
    const interaction = this.interaction;
    const pane = interaction?.hitPane(center);
    if (!interaction || !pane) {
      return;
    }
    const stepX = width * this.panStep;
    const stepY = height * this.panStep;
    switch (action) {
      case 'panLeft':
        interaction.pan(pane, { x: stepX, y: 0 }, 'x');
        break;
      case 'panRight':
        interaction.pan(pane, { x: -stepX, y: 0 }, 'x');
        break;
      case 'panUp':
        interaction.pan(pane, { x: 0, y: stepY }, 'y');
        break;
      case 'panDown':
        interaction.pan(pane, { x: 0, y: -stepY }, 'y');
        break;
      case 'zoomIn':
        interaction.zoom(pane, center, 1 / this.zoomStep, 'both');
        break;
      case 'zoomOut':
        interaction.zoom(pane, center, this.zoomStep, 'both');
        break;
      case 'autoRange':
        interaction.autoRangePane(pane);
        break;
      case 'undo':
        interaction.undo();
        break;
      default:
        interaction.redo();
        break;
    }
  }
}
