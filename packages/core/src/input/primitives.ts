// Platform-neutral input (InputPrimitives of the .NET version). Positions are device-independent units relative to the
// chart; a host such as the element package translates the events of its platform into these.

/** A point in device-independent units relative to the top left of the chart. */
export interface Point {
  /** From the left edge of the chart. */
  readonly x: number;
  /** From the top edge of the chart. */
  readonly y: number;
}

/** Keys held with an input, as bit flags. */
export const InputModifiers = {
  none: 0,
  shift: 1,
  control: 2,
  alt: 4,
  meta: 8,
} as const;

/** A pointer button. */
export type PointerButton = 'none' | 'primary' | 'secondary' | 'middle' | 'x1' | 'x2';

/** What happened to a pointer. */
export type PointerEventKind = 'entered' | 'moved' | 'pressed' | 'released' | 'exited' | 'canceled';

/** The kind of device behind a pointer. */
export type PointerDeviceKind = 'unknown' | 'mouse' | 'touch' | 'pen';

/** A pointer that entered, moved, was pressed or released. */
export interface PointerInputEvent {
  /** What happened. */
  readonly kind: PointerEventKind;
  /** Tells several pointers apart, such as two fingers. */
  readonly pointerId: number;
  /** Where it happened. */
  readonly position: Point;
  /** The button that was pressed or released; `none` for moves. */
  readonly changedButton: PointerButton;
  /** The {@link InputModifiers} held. */
  readonly modifiers: number;
  /** The device behind the pointer. */
  readonly deviceKind: PointerDeviceKind;
  /** 2 for the second press of a double click, 1 for a single press, 0 for other events. */
  readonly clickCount: number;
}

/** A turn of the wheel. */
export interface WheelInputEvent {
  /** Where it happened. */
  readonly position: Point;
  /** Notches; a positive Y turns away from the user, which zooms in. */
  readonly delta: Point;
  /** The {@link InputModifiers} held. */
  readonly modifiers: number;
}

/** The keys a chart understands: letters, digits, arrows and the keys for navigation. */
export type ChartKey =
  | 'Backspace'
  | 'Tab'
  | 'Enter'
  | 'Escape'
  | 'Space'
  | 'PageUp'
  | 'PageDown'
  | 'End'
  | 'Home'
  | 'Left'
  | 'Up'
  | 'Right'
  | 'Down'
  | 'Insert'
  | 'Delete'
  | 'Add'
  | 'Subtract'
  | 'F12'
  | `D${0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`
  | 'A'
  | 'B'
  | 'C'
  | 'D'
  | 'E'
  | 'F'
  | 'G'
  | 'H'
  | 'I'
  | 'J'
  | 'K'
  | 'L'
  | 'M'
  | 'N'
  | 'O'
  | 'P'
  | 'Q'
  | 'R'
  | 'S'
  | 'T'
  | 'U'
  | 'V'
  | 'W'
  | 'X'
  | 'Y'
  | 'Z';

/** A key that went down or up. */
export interface KeyInputEvent {
  /** Whether the key went down or up. */
  readonly kind: 'pressed' | 'released';
  /** The key. */
  readonly key: ChartKey;
  /** The {@link InputModifiers} held. */
  readonly modifiers: number;
  /** Whether the key repeats because it is held. */
  readonly isRepeat: boolean;
}

/** A key with the modifiers that must be held, pressed or released. */
export interface KeyBinding {
  /** The key. */
  readonly key: ChartKey;
  /** The {@link InputModifiers} that must be held, exactly; none when left out. */
  readonly modifiers?: number;
  /** Pressed when left out. */
  readonly kind?: 'pressed' | 'released';
}

/** Whether a key event is the one a binding names. */
export function matchesKey(binding: KeyBinding, input: KeyInputEvent): boolean {
  return (
    input.key === binding.key &&
    input.modifiers === (binding.modifiers ?? InputModifiers.none) &&
    input.kind === (binding.kind ?? 'pressed')
  );
}

/** A gesture of several fingers: moving them together pans, spreading them zooms. */
export interface GestureInputEvent {
  /** Moving the fingers together or spreading them. */
  readonly kind: 'pan' | 'pinch';
  /** Where in the gesture the event is. */
  readonly phase: 'started' | 'changed' | 'completed' | 'canceled';
  /** The middle of the fingers. */
  readonly position: Point;
  /** How far the middle moved since the last event. */
  readonly delta: Point;
  /** How much the distance of the fingers grew since the last event; 1 for no change. */
  readonly scale: number;
  /** The {@link InputModifiers} held. */
  readonly modifiers: number;
}
