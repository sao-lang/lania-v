export type MouseSnapshot = {
  type: string;
  clientX: number;
  clientY: number;
  pageX: number;
  pageY: number;
  screenX: number;
  screenY: number;
  movementX: number;
  movementY: number;
  button: number;
  buttons: number;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  target: string;
  timeStamp: number;
};

type MouseSnapshotEvent = Pick<
  MouseEvent,
  | 'type'
  | 'clientX'
  | 'clientY'
  | 'pageX'
  | 'pageY'
  | 'screenX'
  | 'screenY'
  | 'movementX'
  | 'movementY'
  | 'button'
  | 'buttons'
  | 'altKey'
  | 'ctrlKey'
  | 'metaKey'
  | 'shiftKey'
  | 'target'
  | 'timeStamp'
>;

const getTargetLabel = (target: EventTarget | null): string => {
  if (!target || typeof target !== 'object' || !('tagName' in target)) {
    return target?.constructor.name ?? 'unknown';
  }

  const tagName =
    typeof target.tagName === 'string'
      ? target.tagName.toLowerCase()
      : 'element';
  const idValue =
    'id' in target && typeof target.id === 'string' ? target.id : '';
  const classes =
    'className' in target && typeof target.className === 'string'
      ? target.className.trim().split(/\s+/).filter(Boolean).join('.')
      : '';
  const id = idValue ? `#${idValue}` : '';
  const className = classes ? `.${classes}` : '';

  return `${tagName}${id}${className}`;
};

export const createMouseSnapshot = (
  event: MouseSnapshotEvent
): MouseSnapshot => ({
  type: event.type,
  clientX: event.clientX,
  clientY: event.clientY,
  pageX: event.pageX,
  pageY: event.pageY,
  screenX: event.screenX,
  screenY: event.screenY,
  movementX: event.movementX,
  movementY: event.movementY,
  button: event.button,
  buttons: event.buttons,
  altKey: event.altKey,
  ctrlKey: event.ctrlKey,
  metaKey: event.metaKey,
  shiftKey: event.shiftKey,
  target: getTargetLabel(event.target),
  timeStamp: event.timeStamp,
});

export const initialMouseSnapshot: MouseSnapshot = {
  type: 'waiting',
  clientX: 0,
  clientY: 0,
  pageX: 0,
  pageY: 0,
  screenX: 0,
  screenY: 0,
  movementX: 0,
  movementY: 0,
  button: -1,
  buttons: 0,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  target: '—',
  timeStamp: 0,
};
