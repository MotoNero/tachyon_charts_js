// Moving and resizing editable annotations with the pointer, removing the chosen one with Delete, and undoing and
// redoing edits with Ctrl+Z and Ctrl+Y, as AnnotationEditModifier of the .NET version.
import type { Axis } from '../axes/axis';
import type { ChartInteraction, ChartEdit } from '../input/chart-interaction';
import { ChartModifier, type ModifierResult } from '../input/modifier-pipeline';
import {
  InputModifiers,
  matchesKey,
  type KeyInputEvent,
  type Point,
  type PointerInputEvent,
} from '../input/primitives';
import { Annotation } from './annotations';

const undoKey = { key: 'Z', modifiers: InputModifiers.control } as const;
const redoKey = { key: 'Y', modifiers: InputModifiers.control } as const;

// A distance in pixels as one along an axis.
function toAxisDistance(interaction: ChartInteraction, axis: Axis | undefined, pixels: number): number {
  const layout = interaction.chart.currentLayout;
  if (!axis || !layout) {
    return pixels;
  }
  const start = axis.isHorizontal ? layout.plotArea.x : layout.plotArea.y;
  const placement = layout.axes.find((item) => item.axis === axis);
  if (!placement) {
    return 0;
  }
  const bounds = placement.bounds;
  const transform = axis.isHorizontal
    ? axis.createTransform(bounds.x, bounds.width)
    : axis.createTransform(bounds.y, bounds.height);
  return transform.toData(start + pixels) - transform.toData(start);
}

function sameState(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Edits the annotations whose `isEditable` is set. */
export class AnnotationEditModifier extends ChartModifier {
  /** The priority, above legends, zooming and panning. */
  static readonly defaultPriority = 45;
  /** How far beside an annotation the pointer still finds it, in device-independent units; 5 by default. */
  tolerance = 5;
  /** Called when Delete removes an annotation. */
  onRemoved: ((annotation: Annotation) => void) | undefined;
  private active: Annotation | undefined;
  private selected: Annotation | undefined;
  private hot: Annotation | undefined;
  private before: unknown;
  private last: Point = { x: 0, y: 0 };
  private pointerId = 0;
  private handle = -1;
  private isResizing = false;

  constructor() {
    super(AnnotationEditModifier.defaultPriority);
  }

  /** {@inheritDoc ChartModifier.onPointer} */
  override onPointer(input: PointerInputEvent): ModifierResult {
    if (this.active) {
      return input.pointerId === this.pointerId ? this.continueDrag(input) : 'ignored';
    }
    const interaction = this.interaction;
    if (!interaction) {
      return 'ignored';
    }
    if (input.kind === 'moved' || input.kind === 'exited') {
      this.hover(interaction, input.kind === 'exited' ? undefined : this.find(interaction, input.position));
      return 'ignored';
    }
    const annotation =
      input.kind === 'pressed' && input.changedButton === 'primary'
        ? this.find(interaction, input.position)
        : undefined;
    if (!annotation) {
      return 'ignored';
    }
    this.active = annotation;
    this.selected = annotation;
    this.pointerId = input.pointerId;
    this.last = input.position;
    this.handle = annotation.handleAt(input.position, this.tolerance);
    this.isResizing = this.handle < 0 && this.isAtCorner(annotation, input.position);
    this.before = annotation.capture();
    this.hover(interaction, annotation);
    return 'capture';
  }

  /** {@inheritDoc ChartModifier.onKey} */
  override onKey(input: KeyInputEvent): ModifierResult {
    const interaction = this.interaction;
    if (!interaction || input.kind !== 'pressed') {
      return 'ignored';
    }
    const isUndo = matchesKey(undoKey, input);
    if (isUndo || matchesKey(redoKey, input)) {
      interaction.run(() => {
        if (isUndo) {
          interaction.history.undo(interaction.chart);
        } else {
          interaction.history.redo(interaction.chart);
        }
      });
      return 'handled';
    }
    const annotation = this.selected;
    if (input.key !== 'Delete' || !annotation) {
      return 'ignored';
    }
    this.selected = undefined;
    interaction.run(() => {
      interaction.chart.removeOverlay(annotation);
    });
    this.onRemoved?.(annotation);
    return 'handled';
  }

  /** {@inheritDoc ChartModifier.onCaptureLost} */
  override onCaptureLost(): void {
    this.finish();
  }

  private find(interaction: ChartInteraction, position: Point): Annotation | undefined {
    const overlays = interaction.chart.overlays;
    for (let i = overlays.length - 1; i >= 0; i--) {
      const overlay = overlays[i];
      if (
        overlay instanceof Annotation &&
        overlay.isEditable &&
        (overlay.handleAt(position, this.tolerance) >= 0 || overlay.contains(position, this.tolerance))
      ) {
        return overlay;
      }
    }
    return undefined;
  }

  private hover(interaction: ChartInteraction, annotation: Annotation | undefined): void {
    if (annotation === this.hot) {
      return;
    }
    const previous = this.hot;
    this.hot = annotation;
    interaction.run(() => {
      if (previous) {
        previous.isHot = false;
      }
      if (annotation) {
        annotation.isHot = true;
      }
    });
  }

  private isAtCorner(annotation: Annotation, position: Point): boolean {
    const bounds = annotation.lastBounds;
    return bounds !== undefined && Math.hypot(position.x - bounds.right, position.y - bounds.bottom) <= this.tolerance;
  }

  private continueDrag(input: PointerInputEvent): ModifierResult {
    switch (input.kind) {
      case 'moved':
        this.drag(input.position);
        return 'handled';
      case 'released':
      case 'canceled':
        this.finish();
        return 'release';
      default:
        return 'handled';
    }
  }

  private finish(): void {
    const annotation = this.active;
    if (!annotation) {
      return;
    }
    this.active = undefined;
    const before = this.before;
    this.before = undefined;
    const interaction = this.interaction;
    if (!interaction) {
      return;
    }
    interaction.run(() => {
      const after = annotation.capture();
      if (before !== undefined && after !== undefined && !sameState(before, after)) {
        interaction.history.recordEdit(annotationChange(annotation, before, after));
      }
      annotation.notifyEditFinished();
    });
  }

  private drag(position: Point): void {
    const delta = { x: position.x - this.last.x, y: position.y - this.last.y };
    this.last = position;
    const annotation = this.active;
    const interaction = this.interaction;
    if (!annotation || !interaction) {
      return;
    }
    const handle = this.handle;
    const isResizing = this.isResizing;
    interaction.run(() => {
      // Each axis takes the move along its own direction, also when the X axis runs down.
      const deltaX = toAxisDistance(
        interaction,
        annotation.xAxis,
        annotation.xAxis?.isHorizontal === false ? delta.y : delta.x,
      );
      const deltaY = toAxisDistance(
        interaction,
        annotation.yAxis,
        annotation.yAxis?.isHorizontal === true ? delta.x : delta.y,
      );
      if (handle >= 0) {
        annotation.moveHandle(handle, deltaX, deltaY);
      } else if (!isResizing || !annotation.resize(deltaX, deltaY)) {
        annotation.move(deltaX, deltaY);
      }
      annotation.notifyEdited();
    });
  }
}

function annotationChange(annotation: Annotation, before: unknown, after: unknown): ChartEdit {
  const apply = (state: unknown): void => {
    annotation.restore(state);
    annotation.notifyEdited();
    annotation.notifyEditFinished();
  };
  return {
    undo: () => {
      apply(before);
    },
    redo: () => {
      apply(after);
    },
  };
}
