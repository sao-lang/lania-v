import {
  bindHandlers,
  bindProps,
  bindSlots,
  createExpose,
  createRef,
  createSignal,
  defineComponent,
  Each,
} from '@lania-v/runtime';

type BindingPanelExpose = {
  focusInput(): void;
  clearInput(): void;
  submitFromExpose(): void;
};

type BindingInputExpose = {
  focus(): void;
  clear(): void;
};

type BindingPanelProps = {
  title: string;
  count: number;
  collapsed?: boolean;
  status?: string;
  onToggle?: () => void;
  onSubmit?: (id: string) => void;
  ref?: BindingPanelExpose;
  children?: unknown;
};

const BindingPanel = defineComponent(function BindingPanel(props: BindingPanelProps) {
  const p = bindProps(props);
  const h = bindHandlers(props);
  const slots = bindSlots();
  const inputRef = createRef<HTMLInputElement>();
  // 编译组件里本地引用会被改写成 `this.xxx`，因此这里用箭头函数保留组件 `this`。
  createExpose(props, {
    focusInput: () => {
      inputRef?.focus();
    },
    clearInput: () => {
      if (inputRef) {
        inputRef.value = '';
      }
    },
    submitFromExpose: () => {
      h.onSubmit?.(`panel-${p.count}`);
    },
  });

  return (
    <section
      className="surface-light"
      style={{
        padding: '14px',
        borderRadius: '14px',
        border: '1px solid rgba(148, 163, 184, 0.35)',
        background: '#ffffff',
        display: 'grid',
        gap: '12px',
      }}
    >
      <div>
        <p className="summary">bindProps(props)</p>
        <p className="empty">
          keys: {Object.keys(p).join(', ') || '(empty)'}
        </p>
      </div>

      <div>
        <p className="summary">bindHandlers(props)</p>
        <p className="empty">
          keys: {Object.keys(h).join(', ') || '(empty)'}
        </p>
      </div>

      <header>
        {slots.render(
          'header',
          <div>
            <p className="summary">header fallback</p>
            <h4 style={{ margin: '6px 0 0' }}>{p.title}</h4>
          </div>
        ) as any}
      </header>

      <div className="row">
        <span className="summary">title: {p.title}</span>
        <span className="summary">count: {p.count}</span>
        <span className="summary">collapsed: {String(Boolean(p.collapsed))}</span>
        <span className="summary">status: {p.status ?? '-'}</span>
      </div>

      <div>
        <p className="summary">bindSlots().renderDefault()</p>
        <div>
          {slots.renderDefault(
            <p className="empty">default slot fallback</p>
          ) as any}
        </div>
      </div>

      <div>
        <p className="summary">bindSlots().has('footer')</p>
        {slots.has('footer') ? (
          <div>{slots.render('footer') as any}</div>
        ) : (
          <p className="empty">footer slot is missing</p>
        )}
      </div>

      <div className="row">
        <input
          ref={inputRef}
          className="input"
          placeholder="focus / clear via createExpose"
          value={p.title}
        />
        <button className="btn" onClick={() => h.onToggle?.()}>
          call onToggle
        </button>
        <button className="btn" onClick={() => h.onSubmit?.(`panel-${p.count}`)}>
          call onSubmit
        </button>
      </div>
    </section>
  );
});

const BindingInput = defineComponent(function BindingInput(props: {
  value: string;
  ref?: BindingInputExpose;
}) {
  const inputRef = createRef<HTMLInputElement>();

  createExpose(props, {
    focus: () => {
      inputRef?.focus();
    },
    clear: () => {
      if (inputRef) {
        inputRef.value = '';
      }
    },
  });

  return (
    <section
      className="surface-light"
      style={{
        padding: '14px',
        borderRadius: '14px',
        border: '1px solid rgba(148, 163, 184, 0.35)',
        background: '#ffffff',
        display: 'grid',
        gap: '12px',
      }}
    >
      <p className="summary">InputExpose minimal example</p>
      <p className="empty">
        这个例子只聚焦 `createExpose(props, exposed)` + `createRef()`
        的最小组合。
      </p>
      <input
        ref={inputRef}
        className="input"
        value={props.value}
        placeholder="focus / clear from parent"
      />
    </section>
  );
});

export default defineComponent(function FcBindingApiDemo() {
  const collapsed = createSignal(false);
  const panelTitle = createSignal('FC Binding Panel');
  const footerEnabled = createSignal(true);
  const panelRef = createRef<BindingPanelExpose>();
  const inputExposeRef = createRef<BindingInputExpose>();
  const submitLog = createSignal<string[]>([]);

  const pushSubmitLog = (label: string) => {
    submitLog.set((previous) => [label, ...previous].slice(0, 6));
  };

  const buildSlotObject = () => {
    return {
      header: (
        <div>
          <p className="summary">named slot: header</p>
          <h4 style={{ margin: '6px 0 0' }}>{panelTitle()}</h4>
        </div>
      ),
      default: (
        <div>
          <p className="empty">
            这里是默认插槽内容。可以直接看到 `bindSlots()` 如何读取默认槽。
          </p>
          <p className="empty">
            当前状态: collapsed = {String(collapsed())}
          </p>
        </div>
      ),
      ...(footerEnabled()
        ? {
            footer: (
              <p className="empty">
                named slot: footer is enabled
              </p>
            ),
          }
        : {}),
    };
  };

  return (
    <section className="todo-card">
      <header>
        <h3>FC Binding APIs Demo</h3>
        <p className="summary">
          完整演示 `bindProps()`、`bindHandlers()`、`bindSlots()`、`createExpose()`
          的组合用法。
        </p>
      </header>

      <div className="list">
        <div className="item">
          <p className="summary">父组件控制区</p>
          <div className="row">
            <button
              className="btn"
              onClick={() => collapsed.set((value) => !value)}
            >
              collapsed: {String(collapsed())}
            </button>
            <button
              className="btn"
              onClick={() =>
                panelTitle.set((value) =>
                  value === 'FC Binding Panel'
                    ? 'Panel Title Updated'
                    : 'FC Binding Panel'
                )
              }
            >
              toggle title
            </button>
            <button
              className="btn"
              onClick={() => footerEnabled.set((value) => !value)}
            >
              footer slot: {String(footerEnabled())}
            </button>
          </div>
          <div className="row">
            <button
              className="btn"
              onClick={() => panelRef?.focusInput()}
            >
              ref.focusInput()
            </button>
            <button
              className="btn"
              onClick={() => panelRef?.clearInput()}
            >
              ref.clearInput()
            </button>
            <button
              className="btn"
              onClick={() => panelRef?.submitFromExpose()}
            >
              ref.submitFromExpose()
            </button>
          </div>
          <p className="empty">
            这个 ref 公开面来自子组件内部的 `createExpose(props, exposed)`。
          </p>
        </div>

        <div className="item">
          <p className="summary">子组件实例</p>
          <BindingPanel
            ref={panelRef}
            title={panelTitle()}
            count={submitLog().length}
            collapsed={collapsed()}
            status={footerEnabled() ? 'footer-ready' : 'footer-hidden'}
            onToggle={() => {
              collapsed.set((value) => !value);
              pushSubmitLog('toggle from bindHandlers');
            }}
            onSubmit={(id: string) => {
              pushSubmitLog(`submit from bindHandlers: ${id}`);
            }}
            children={buildSlotObject()}
          />
        </div>

        <div className="item">
          <p className="summary">InputExpose 示例</p>
          <div className="row">
            <button
              className="btn"
              onClick={() => inputExposeRef?.focus()}
            >
              inputRef.focus()
            </button>
            <button
              className="btn"
              onClick={() => inputExposeRef?.clear()}
            >
              inputRef.clear()
            </button>
          </div>
          <BindingInput ref={inputExposeRef} value="Input expose demo" />
        </div>

        <div className="item">
          <p className="summary">submit logs</p>
          <Each items={submitLog()} fallback={<p className="empty">no logs yet</p>}>
            {(line: string): any => <p className="empty">{line}</p>}
          </Each>
        </div>
      </div>
    </section>
  );
});
