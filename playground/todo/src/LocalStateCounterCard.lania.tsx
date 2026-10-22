import { createSignal, defineComponent } from '@lania-v/runtime';

export default defineComponent(function LocalStateCounterCard() {
  const localCount = createSignal(0);
  const localDraft = createSignal('local draft');

  return (
    <div className="item" data-debug="local-state-counter-card">
      <p className="summary">组件内部状态（React/Vue 风格 remount）</p>
      <p className="empty">
        先修改下面的 count / input，再切到别的 tab
        后回来。因为状态定义在子组件内部，所以会回到初始值。
      </p>
      <p>
        local count: <span>{localCount.value}</span>
      </p>
      <div className="row">
        <button className="btn" onClick={() => localCount.set((v) => v + 1)}>
          local +1
        </button>
        <button className="btn" onClick={() => localCount.set(0)}>
          local reset
        </button>
      </div>
      <input
        className="input"
        value={localDraft.value}
        onInput={(event: Event) => {
          const target = event.target as HTMLInputElement | null;
          localDraft.set(target?.value ?? '');
        }}
      />
    </div>
  );
});
