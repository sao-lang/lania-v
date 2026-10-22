import {
  createEffect,
  createSignal,
  css,
  defineComponent,
  onCleanup,
  onMount,
  type Signal,
} from '@lania-v/runtime';
import {
  createMouseSnapshot,
  initialMouseSnapshot,
  type MouseSnapshot,
} from './mouseSnapshot';

const MouseTracker = defineComponent(function MouseTracker() {
  const mouse = createSignal<MouseSnapshot>(initialMouseSnapshot);
  const useMouse = (snapshot: Signal<MouseSnapshot>) => {
    const eventTypes = [
      'mousemove',
      'mousedown',
      'mouseup',
      'click',
      'dblclick',
      'contextmenu',
      'mouseover',
      'mouseout',
    ] as const;

    const handleMouseEvent = (event: Event) => {
      if (!(event instanceof MouseEvent)) return;
      snapshot.set(createMouseSnapshot(event));
    };

    createEffect(() => {
      console.log('[useMouse]', snapshot.value);
    });

    return {
      mount() {
        eventTypes.forEach((type) =>
          window.addEventListener(type, handleMouseEvent)
        );
      },
      unmount() {
        eventTypes.forEach((type) =>
          window.removeEventListener(type, handleMouseEvent)
        );
      },
    };
  };

  const mouseListeners = useMouse(mouse);
  onMount(() => mouseListeners.mount());
  onCleanup(() => mouseListeners.unmount());

  return (
    <section className="mouse-card">
      <header className="mouse-header">
        <div>
          <p className="mouse-eyebrow">lania-v custom hook</p>
          <h2>Live mouse snapshot</h2>
        </div>
        <span className="mouse-event">{mouse.value.type}</span>
      </header>

      <div className="mouse-coordinates">
        <div>
          <span>client</span>
          <strong>
            {mouse.value.clientX}, {mouse.value.clientY}
          </strong>
        </div>
        <div>
          <span>page</span>
          <strong>
            {mouse.value.pageX}, {mouse.value.pageY}
          </strong>
        </div>
        <div>
          <span>screen</span>
          <strong>
            {mouse.value.screenX}, {mouse.value.screenY}
          </strong>
        </div>
        <div>
          <span>movement</span>
          <strong>
            {mouse.value.movementX}, {mouse.value.movementY}
          </strong>
        </div>
      </div>

      <dl className="mouse-details">
        <div>
          <dt>target</dt>
          <dd>{mouse.value.target}</dd>
        </div>
        <div>
          <dt>button / buttons</dt>
          <dd>
            {mouse.value.button} / {mouse.value.buttons}
          </dd>
        </div>
        <div>
          <dt>modifiers</dt>
          <dd>
            alt {String(mouse.value.altKey)} · ctrl{' '}
            {String(mouse.value.ctrlKey)} · shift {String(mouse.value.shiftKey)}{' '}
            · meta {String(mouse.value.metaKey)}
          </dd>
        </div>
        <div>
          <dt>event timestamp</dt>
          <dd>{mouse.value.timeStamp.toFixed(1)} ms</dd>
        </div>
      </dl>

      <p className="mouse-hint">
        移动鼠标、点击或按住鼠标键；快照会同步更新并打印到控制台。
      </p>
    </section>
  );
});

MouseTracker.styles = css`
  :host {
    display: block;
    color: #e8ecf5;
    font-family: ui-sans-serif, system-ui, sans-serif;
  }

  * {
    box-sizing: border-box;
  }

  .mouse-card {
    padding: 24px;
    border: 1px solid rgba(155, 170, 200, 0.22);
    border-radius: 20px;
    background: linear-gradient(
      145deg,
      rgba(26, 34, 55, 0.96),
      rgba(16, 22, 39, 0.98)
    );
    box-shadow: 0 24px 70px rgba(0, 0, 0, 0.3);
  }

  .mouse-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 16px;
  }

  .mouse-eyebrow {
    margin: 0 0 8px;
    color: #a78bfa;
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }

  h2 {
    margin: 0;
    font-size: 22px;
  }

  .mouse-event {
    padding: 6px 10px;
    border: 1px solid rgba(167, 139, 250, 0.38);
    border-radius: 999px;
    color: #d8ccff;
    background: rgba(139, 92, 246, 0.14);
    font-family: ui-monospace, monospace;
    font-size: 12px;
  }

  .mouse-coordinates {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 10px;
    margin-top: 24px;
  }

  .mouse-coordinates > div,
  .mouse-details > div {
    min-width: 0;
    padding: 13px;
    border: 1px solid rgba(155, 170, 200, 0.14);
    border-radius: 12px;
    background: rgba(255, 255, 255, 0.035);
  }

  .mouse-coordinates span,
  .mouse-details dt {
    display: block;
    margin-bottom: 8px;
    color: #99a5bc;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .mouse-coordinates strong {
    color: #f3f5fb;
    font-family: ui-monospace, monospace;
    font-size: clamp(13px, 2vw, 18px);
    overflow-wrap: anywhere;
  }

  .mouse-details {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
    margin: 10px 0 0;
  }

  .mouse-details dt,
  .mouse-details dd {
    margin: 0;
  }

  .mouse-details dd {
    color: #e3e8f3;
    font-family: ui-monospace, monospace;
    font-size: 12px;
    overflow-wrap: anywhere;
  }

  .mouse-hint {
    margin: 18px 0 0;
    color: #9ba7bd;
    font-size: 12px;
  }

  @media (max-width: 640px) {
    .mouse-card {
      padding: 18px;
    }

    .mouse-coordinates {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
`;

export default MouseTracker;
