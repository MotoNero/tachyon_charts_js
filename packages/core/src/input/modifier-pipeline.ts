// Modifiers and the pipeline that hands input to them (ChartModifier and ModifierPipeline of the .NET version).
import type { ChartInteraction } from './chart-interaction';
import type { GestureInputEvent, KeyInputEvent, PointerInputEvent, WheelInputEvent } from './primitives';

/**
 * What a modifier did with an input: nothing, handled it, handled it and wants the rest of this pointer, key or
 * gesture (`capture`), or is done with what it captured (`release`).
 */
export type ModifierResult = 'ignored' | 'handled' | 'capture' | 'release';

/** What a modifier lost: the input of a pointer, the keyboard or a gesture. */
export interface InputCapture {
  /** What was captured. */
  readonly kind: 'pointer' | 'keyboard' | 'gesture';
  /** The pointer, for a pointer capture. */
  readonly pointerId: number;
}

/** A platform-neutral interaction with a chart. Modifiers of higher priority get uncaptured input first. */
export abstract class ChartModifier {
  private chartInteraction: ChartInteraction | undefined;
  /** Whether the modifier takes input; a disabled one loses its captures. */
  isEnabled = true;

  constructor(
    /** Modifiers with higher numbers get the input first. */
    readonly priority = 0,
  ) {}

  /** The chart the modifier works on, while it is in a pipeline with one. */
  get interaction(): ChartInteraction | undefined {
    return this.chartInteraction;
  }

  /** Sets the interaction; the pipeline calls it. */
  attach(value: ChartInteraction | undefined): void {
    if (this.chartInteraction) {
      this.onDetached(this.chartInteraction);
    }
    this.chartInteraction = value;
    if (value) {
      this.onAttached(value);
    }
  }

  /** Called when the modifier starts to work on a chart. */
  protected onAttached(_interaction: ChartInteraction): void {
    // Most modifiers need no setup.
  }

  /** Called when the modifier stops working on a chart. */
  protected onDetached(_interaction: ChartInteraction): void {
    // Most modifiers keep nothing on the chart.
  }

  /** Handles a pointer event. */
  onPointer(_input: PointerInputEvent): ModifierResult {
    return 'ignored';
  }

  /** Handles a turn of the wheel; it can be handled, not captured. */
  onWheel(_input: WheelInputEvent): ModifierResult {
    return 'ignored';
  }

  /** Handles a key. */
  onKey(_input: KeyInputEvent): ModifierResult {
    return 'ignored';
  }

  /** Handles a gesture of several fingers. */
  onGesture(_input: GestureInputEvent): ModifierResult {
    return 'ignored';
  }

  /** Called when a capture ends without a release, such as when the modifier is disabled or removed. */
  onCaptureLost(_capture: InputCapture): void {
    // Most modifiers keep no state between events.
  }
}

const isPointerEnd = (kind: PointerInputEvent['kind']): boolean => kind === 'released' || kind === 'canceled';
const isGestureEnd = (phase: GestureInputEvent['phase']): boolean => phase === 'completed' || phase === 'canceled';

/** Hands platform-neutral input to modifiers in the order of their priority and keeps their captures. */
export class ModifierPipeline {
  private readonly list: ChartModifier[] = [];
  private readonly pointerCaptures = new Map<number, ChartModifier>();
  private keyboardCapture: ChartModifier | undefined;
  private gestureCapture: ChartModifier | undefined;
  private chartInteraction: ChartInteraction | undefined;

  /** The chart the modifiers work on. */
  get interaction(): ChartInteraction | undefined {
    return this.chartInteraction;
  }

  set interaction(value: ChartInteraction | undefined) {
    this.chartInteraction = value;
    for (const modifier of this.list) {
      modifier.attach(value);
    }
  }

  /** The modifiers, the highest priority first. */
  get modifiers(): readonly ChartModifier[] {
    return this.list;
  }

  /**
   * Adds a modifier after those of the same or a higher priority.
   * @throws RangeError when it is in the pipeline already.
   */
  add(modifier: ChartModifier): void {
    if (this.list.includes(modifier)) {
      throw new RangeError('The modifier is already in this pipeline.');
    }
    let index = 0;
    while (index < this.list.length && (this.list[index] as ChartModifier).priority >= modifier.priority) {
      index++;
    }
    this.list.splice(index, 0, modifier);
    modifier.attach(this.chartInteraction);
  }

  /** Removes a modifier, which loses its captures; returns whether it was there. */
  remove(modifier: ChartModifier): boolean {
    const index = this.list.indexOf(modifier);
    if (index < 0) {
      return false;
    }
    this.list.splice(index, 1);
    this.releaseCaptures(modifier);
    modifier.attach(undefined);
    return true;
  }

  /** Removes all modifiers. */
  clear(): void {
    this.cancelAllCaptures();
    for (const modifier of this.list) {
      modifier.attach(undefined);
    }
    this.list.length = 0;
  }

  /** Whether a modifier holds the input of a pointer. */
  isPointerCaptured(pointerId: number): boolean {
    return this.pointerCaptures.has(pointerId);
  }

  /** Ends all captures and tells their modifiers, such as when the chart loses the focus. */
  cancelAllCaptures(): void {
    const captures = [...this.pointerCaptures];
    this.pointerCaptures.clear();
    for (const [pointerId, modifier] of captures) {
      modifier.onCaptureLost({ kind: 'pointer', pointerId });
    }
    const keyboard = this.keyboardCapture;
    this.keyboardCapture = undefined;
    keyboard?.onCaptureLost({ kind: 'keyboard', pointerId: 0 });
    const gesture = this.gestureCapture;
    this.gestureCapture = undefined;
    gesture?.onCaptureLost({ kind: 'gesture', pointerId: 0 });
  }

  /** Hands a pointer event over; returns whether a modifier handled it. */
  processPointer(input: PointerInputEvent): boolean {
    if (this.forwardPointer(input)) {
      return true;
    }
    for (const modifier of this.list) {
      if (!modifier.isEnabled) {
        continue;
      }
      const result = modifier.onPointer(input);
      if (result === 'ignored') {
        continue;
      }
      if (result === 'capture' && !isPointerEnd(input.kind)) {
        this.pointerCaptures.set(input.pointerId, modifier);
      }
      return true;
    }
    return false;
  }

  /**
   * Hands a turn of the wheel over; returns whether a modifier handled it.
   * @throws Error when a modifier tries to capture or release it.
   */
  processWheel(input: WheelInputEvent): boolean {
    for (const modifier of this.list) {
      if (!modifier.isEnabled) {
        continue;
      }
      const result = modifier.onWheel(input);
      if (result === 'capture' || result === 'release') {
        throw new Error('Wheel input cannot be captured or released.');
      }
      if (result === 'handled') {
        return true;
      }
    }
    return false;
  }

  /** Hands a key over; returns whether a modifier handled it. */
  processKey(input: KeyInputEvent): boolean {
    const captured = this.keyboardCapture;
    if (captured) {
      if (captured.isEnabled) {
        if (captured.onKey(input) === 'release') {
          this.keyboardCapture = undefined;
        }
        return true;
      }
      this.keyboardCapture = undefined;
      captured.onCaptureLost({ kind: 'keyboard', pointerId: 0 });
    }
    for (const modifier of this.list) {
      if (!modifier.isEnabled) {
        continue;
      }
      const result = modifier.onKey(input);
      if (result === 'ignored') {
        continue;
      }
      if (result === 'capture') {
        this.keyboardCapture = modifier;
      }
      return true;
    }
    return false;
  }

  /** Hands a gesture over; returns whether a modifier handled it. */
  processGesture(input: GestureInputEvent): boolean {
    if (this.forwardGesture(input)) {
      return true;
    }
    for (const modifier of this.list) {
      if (!modifier.isEnabled) {
        continue;
      }
      const result = modifier.onGesture(input);
      if (result === 'ignored') {
        continue;
      }
      if (result === 'capture' && !isGestureEnd(input.phase)) {
        this.gestureCapture = modifier;
      }
      return true;
    }
    return false;
  }

  private forwardPointer(input: PointerInputEvent): boolean {
    const captured = this.pointerCaptures.get(input.pointerId);
    if (!captured) {
      return false;
    }
    if (!captured.isEnabled) {
      this.pointerCaptures.delete(input.pointerId);
      captured.onCaptureLost({ kind: 'pointer', pointerId: input.pointerId });
      return false;
    }
    const result = captured.onPointer(input);
    if (result === 'release' || isPointerEnd(input.kind)) {
      this.pointerCaptures.delete(input.pointerId);
    }
    return true;
  }

  private forwardGesture(input: GestureInputEvent): boolean {
    const captured = this.gestureCapture;
    if (!captured) {
      return false;
    }
    if (!captured.isEnabled) {
      this.gestureCapture = undefined;
      captured.onCaptureLost({ kind: 'gesture', pointerId: 0 });
      return false;
    }
    const result = captured.onGesture(input);
    if (result === 'release' || isGestureEnd(input.phase)) {
      this.gestureCapture = undefined;
    }
    return true;
  }

  private releaseCaptures(modifier: ChartModifier): void {
    for (const [pointerId, holder] of [...this.pointerCaptures]) {
      if (holder === modifier) {
        this.pointerCaptures.delete(pointerId);
        modifier.onCaptureLost({ kind: 'pointer', pointerId });
      }
    }
    if (this.keyboardCapture === modifier) {
      this.keyboardCapture = undefined;
      modifier.onCaptureLost({ kind: 'keyboard', pointerId: 0 });
    }
    if (this.gestureCapture === modifier) {
      this.gestureCapture = undefined;
      modifier.onCaptureLost({ kind: 'gesture', pointerId: 0 });
    }
  }
}
