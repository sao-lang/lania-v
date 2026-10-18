import { describe, expect, it } from 'vitest';
import { createMouseSnapshot } from '../playground/mouse-hook/src/mouseSnapshot';

const mouseEvent = (target: EventTarget) => ({
  type: 'mousemove',
  clientX: 120,
  clientY: 240,
  pageX: 128,
  pageY: 252,
  screenX: 900,
  screenY: 600,
  movementX: 4,
  movementY: -3,
  button: 0,
  buttons: 1,
  altKey: false,
  ctrlKey: true,
  metaKey: false,
  shiftKey: true,
  target,
  timeStamp: 1234.5,
});

describe('createMouseSnapshot', () => {
  it('captures coordinates, button state, modifiers, target, and event timing', () => {
    const target = Object.assign(new EventTarget(), {
      tagName: 'BUTTON',
      id: 'track',
      className: 'mouse-target active',
    });

    const snapshot = createMouseSnapshot(mouseEvent(target));

    expect(snapshot).toEqual({
      type: 'mousemove',
      clientX: 120,
      clientY: 240,
      pageX: 128,
      pageY: 252,
      screenX: 900,
      screenY: 600,
      movementX: 4,
      movementY: -3,
      button: 0,
      buttons: 1,
      altKey: false,
      ctrlKey: true,
      metaKey: false,
      shiftKey: true,
      target: 'button#track.mouse-target.active',
      timeStamp: 1234.5,
    });
  });

  it('does not add a class suffix when the event target has no classes', () => {
    const target = Object.assign(new EventTarget(), {
      tagName: 'BODY',
      id: '',
      className: '',
    });

    expect(createMouseSnapshot(mouseEvent(target)).target).toBe('body');
  });
});
