// Translates the input events of the browser into the platform-neutral input of the modifier pipeline: pointer events
// of mouse, pen and touch, two fingers as pan and pinch gestures, the wheel in notches and the keys a chart knows.
import {
  InputModifiers,
  type ChartKey,
  type GestureInputEvent,
  type ModifierPipeline,
  type Point,
  type PointerButton,
  type PointerDeviceKind,
  type PointerInputEvent,
} from '@tachyon-charts/core';

/** Options of {@link bindChartInput}. */
export interface InputBindingOptions {
  /** The longest time between two presses of a double click, in milliseconds; 400. */
  readonly doubleClickTime?: number;
  /** The farthest the pointer may move between the two presses, in CSS pixels; 5. */
  readonly doubleClickDistance?: number;
}

const buttons: readonly PointerButton[] = ['primary', 'middle', 'secondary', 'x1', 'x2'];

const namedKeys: Readonly<Record<string, ChartKey>> = {
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  '+': 'Add',
  '-': 'Subtract',
  Escape: 'Escape',
  Enter: 'Enter',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Insert: 'Insert',
  Delete: 'Delete',
  ' ': 'Space',
  F12: 'F12',
};

/** The chart key of a key of the browser, `undefined` for keys a chart does not know. */
export function chartKeyOf(key: string): ChartKey | undefined {
  const named = namedKeys[key];
  if (named) {
    return named;
  }
  if (/^[a-z]$/i.test(key)) {
    return key.toUpperCase() as ChartKey;
  }
  return /^\d$/.test(key) ? (`D${key}` as ChartKey) : undefined;
}

/** The modifier keys held during a browser event, as the bit flags of `InputModifiers`. */
export function modifiersOf(event: { shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean }): number {
  return (
    (event.shiftKey ? InputModifiers.shift : 0) |
    (event.ctrlKey ? InputModifiers.control : 0) |
    (event.altKey ? InputModifiers.alt : 0) |
    (event.metaKey ? InputModifiers.meta : 0)
  );
}

/** Notches of a wheel event; a positive Y turns away from the user. */
export function wheelNotches(event: { deltaX: number; deltaY: number; deltaMode: number }): Point {
  // Pixels are a hundred to a notch, lines three; pages are notches already.
  const perNotch = ([100, 3] as const)[event.deltaMode] ?? 1;
  return { x: -event.deltaX / perNotch, y: -event.deltaY / perNotch };
}

interface Finger {
  x: number;
  y: number;
}

interface Gesture {
  readonly fingers: Map<number, Finger>;
  center: Point;
  distance: number;
  isStarted: boolean;
}

/**
 * Feeds the input of an element to a modifier pipeline. Positions are CSS pixels from the top left of the element, the
 * device-independent units of the chart. The element gets the focus on a press, so that keys reach the chart, and
 * stops the browser from scrolling or zooming the page while a finger or the wheel acts on the chart.
 * @returns A function that removes all listeners again.
 */
export function bindChartInput(
  element: HTMLElement,
  pipeline: ModifierPipeline,
  options: InputBindingOptions = {},
): () => void {
  const doubleClickTime = options.doubleClickTime ?? 400;
  const doubleClickDistance = options.doubleClickDistance ?? 5;
  let lastPress = { time: Number.NEGATIVE_INFINITY, x: 0, y: 0, button: 'none' as PointerButton };
  const touches = new Map<number, Finger>();
  let gesture: Gesture | undefined;
  if (element.tabIndex < 0) {
    element.tabIndex = 0;
  }
  element.style.touchAction = 'none';

  const positionOf = (event: { clientX: number; clientY: number }): Point => {
    const bounds = element.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  };

  const pointer = (
    event: PointerEvent,
    kind: PointerInputEvent['kind'],
    changedButton: PointerButton = 'none',
    clickCount = 0,
  ): void => {
    pipeline.processPointer({
      kind,
      pointerId: event.pointerId,
      position: positionOf(event),
      changedButton,
      modifiers: modifiersOf(event),
      deviceKind: (['mouse', 'touch', 'pen'].includes(event.pointerType)
        ? event.pointerType
        : 'unknown') as PointerDeviceKind,
      clickCount,
    });
  };

  const gestureEvent = (
    kind: GestureInputEvent['kind'],
    phase: GestureInputEvent['phase'],
    delta: Point,
    scale: number,
  ): void => {
    if (gesture) {
      pipeline.processGesture({ kind, phase, position: gesture.center, delta, scale, modifiers: InputModifiers.none });
    }
  };

  const measure = (fingers: Map<number, Finger>): { center: Point; distance: number } => {
    const [a, b] = [...fingers.values()] as [Finger, Finger];
    return {
      center: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      distance: Math.hypot(a.x - b.x, a.y - b.y),
    };
  };

  const onDown = (event: PointerEvent): void => {
    const position = positionOf(event);
    if (event.pointerType === 'touch') {
      touches.set(event.pointerId, { x: position.x, y: position.y });
      if (touches.size === 2) {
        // The second finger turns the touch into a gesture: the first one's press ends unfinished.
        const first = [...touches.keys()].find((id) => id !== event.pointerId);
        if (first !== undefined) {
          pipeline.processPointer({
            kind: 'canceled',
            pointerId: first,
            position,
            changedButton: 'none',
            modifiers: InputModifiers.none,
            deviceKind: 'touch',
            clickCount: 0,
          });
        }
        const { center, distance } = measure(touches);
        gesture = { fingers: touches, center, distance, isStarted: false };
        event.preventDefault();
        return;
      }
      if (touches.size > 2) {
        return;
      }
    }
    element.focus({ preventScroll: true });
    try {
      element.setPointerCapture(event.pointerId);
    } catch {
      // A pointer that is gone already, as for events a script sends, cannot be captured; the input still counts.
    }
    const button = buttons[event.button] ?? 'none';
    const isDouble =
      event.timeStamp - lastPress.time <= doubleClickTime &&
      button === lastPress.button &&
      Math.hypot(position.x - lastPress.x, position.y - lastPress.y) <= doubleClickDistance;
    lastPress = isDouble
      ? { time: Number.NEGATIVE_INFINITY, x: 0, y: 0, button: 'none' }
      : { time: event.timeStamp, x: position.x, y: position.y, button };
    pointer(event, 'pressed', button, isDouble ? 2 : 1);
    event.preventDefault();
  };

  const onMove = (event: PointerEvent): void => {
    const finger = touches.get(event.pointerId);
    if (gesture && finger) {
      const position = positionOf(event);
      finger.x = position.x;
      finger.y = position.y;
      const { center, distance } = measure(gesture.fingers);
      const delta = { x: center.x - gesture.center.x, y: center.y - gesture.center.y };
      const scale = gesture.distance > 0 && distance > 0 ? distance / gesture.distance : 1;
      const phase = gesture.isStarted ? 'changed' : 'started';
      gesture.isStarted = true;
      gesture.center = center;
      gesture.distance = distance;
      gestureEvent('pan', phase, delta, 1);
      gestureEvent('pinch', phase, { x: 0, y: 0 }, scale);
      return;
    }
    if (finger) {
      finger.x = positionOf(event).x;
      finger.y = positionOf(event).y;
    }
    if (!gesture) {
      pointer(event, 'moved');
    }
  };

  const onUp = (event: PointerEvent, kind: 'released' | 'canceled'): void => {
    const wasTouch = touches.delete(event.pointerId);
    if (gesture) {
      if (touches.size < 2 && wasTouch) {
        gestureEvent('pan', kind === 'released' ? 'completed' : 'canceled', { x: 0, y: 0 }, 1);
        gesture = undefined;
      }
      return;
    }
    if (wasTouch && touches.size > 0) {
      return;
    }
    pointer(event, kind, buttons[event.button] ?? 'none');
    if (element.hasPointerCapture(event.pointerId)) {
      element.releasePointerCapture(event.pointerId);
    }
  };

  const onWheel = (event: WheelEvent): void => {
    if (
      pipeline.processWheel({ position: positionOf(event), delta: wheelNotches(event), modifiers: modifiersOf(event) })
    ) {
      event.preventDefault();
    }
  };

  const onKey = (event: KeyboardEvent, kind: 'pressed' | 'released'): void => {
    const key = chartKeyOf(event.key);
    if (key && pipeline.processKey({ kind, key, modifiers: modifiersOf(event), isRepeat: event.repeat })) {
      event.preventDefault();
    }
  };

  const listeners: [string, EventListener, AddEventListenerOptions?][] = [
    ['pointerdown', onDown as EventListener],
    ['pointermove', onMove as EventListener],
    [
      'pointerup',
      ((event: PointerEvent) => {
        onUp(event, 'released');
      }) as EventListener,
    ],
    [
      'pointercancel',
      ((event: PointerEvent) => {
        onUp(event, 'canceled');
      }) as EventListener,
    ],
    [
      'pointerenter',
      ((event: PointerEvent) => {
        pointer(event, 'entered');
      }) as EventListener,
    ],
    [
      'pointerleave',
      ((event: PointerEvent) => {
        pointer(event, 'exited');
      }) as EventListener,
    ],
    ['wheel', onWheel as EventListener, { passive: false }],
    [
      'keydown',
      ((event: KeyboardEvent) => {
        onKey(event, 'pressed');
      }) as EventListener,
    ],
    [
      'keyup',
      ((event: KeyboardEvent) => {
        onKey(event, 'released');
      }) as EventListener,
    ],
    [
      'blur',
      () => {
        pipeline.cancelAllCaptures();
      },
    ],
  ];
  for (const [type, listener, listenerOptions] of listeners) {
    element.addEventListener(type, listener, listenerOptions);
  }
  return () => {
    for (const [type, listener] of listeners) {
      element.removeEventListener(type, listener);
    }
  };
}
