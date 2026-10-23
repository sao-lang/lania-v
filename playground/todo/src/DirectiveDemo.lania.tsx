import { defineComponent } from '@lania-v/runtime';
import { createSignal } from '@lania-v/runtime/reactivity';
import { Each, When } from '@lania-v/runtime/advanced';
import './watermark-directive';
import type { PlaygroundWatermarkValue } from './watermark-directive';

export default defineComponent(function DirectiveDemo() {
  const directiveVisible = createSignal(true);
  const watermarkText = createSignal('LANIA DEMO');
  const directiveTone = createSignal<'violet' | 'emerald'>('violet');
  const rotate = createSignal(-18);
  const directiveLog = createSignal<string[]>([]);
  const renderEmpty = (text: string): any => <p className="empty">{text}</p>;

  const pushDirectiveLog = (
    phase: 'mounted' | 'updated' | 'unmounted',
    value?: PlaygroundWatermarkValue,
    oldValue?: PlaygroundWatermarkValue
  ) => {
    const hasMeaningfulUpdate =
      phase !== 'updated' ||
      !oldValue ||
      oldValue.text !== value?.text ||
      oldValue.tone !== value?.tone ||
      oldValue.rotate !== value?.rotate;

    if (!hasMeaningfulUpdate) {
      return;
    }

    const detail =
      phase === 'unmounted'
        ? 'cleanup'
        : oldValue
          ? `${oldValue.text} -> ${value?.text} (${value?.tone}, ${value?.rotate}deg)`
          : `${value?.text} (${value?.tone}, ${value?.rotate}deg)`;
    directiveLog.set((prev) => [`${phase}: ${detail}`, ...prev].slice(0, 6));
  };

  return (
    <section className="todo-card">
      <header>
        <h3>Custom Directive Demo</h3>
        <p className="summary">
          这里只演示 FC 对象式 <code>use</code> 自定义指令注册与生命周期。
        </p>
      </header>

      <div className="item">
        <p className="summary">FC object-style watermark directive</p>
        <p className="empty">
          这里直接使用 <code>use watermark binding</code>
          ，运行时会走 <code>registerDirective watermark</code>。
        </p>

        <div className="row">
          <input
            className="input"
            value={watermarkText.value}
            onInput={(event: Event) => {
              const target = event.target as HTMLInputElement | null;
              watermarkText.set(target?.value || 'LANIA DEMO');
            }}
            placeholder="watermark text"
          />
          <button
            className="btn"
            onClick={() =>
              directiveTone.set((value) =>
                value === 'violet' ? 'emerald' : 'violet'
              )
            }
          >
            tone: {directiveTone.value}
          </button>
          <button
            className="btn"
            onClick={() =>
              rotate.set((value) =>
                value === -18 ? -32 : value === -32 ? -8 : -18
              )
            }
          >
            rotate: {rotate.value}deg
          </button>
          <button
            className="btn"
            onClick={() => directiveVisible.set((value) => !value)}
          >
            visible: {String(directiveVisible.value)}
          </button>
        </div>

        <When
          value={directiveVisible.value}
          fallback={renderEmpty('target removed, directive unmounted')}
        >
          <div
            use={{
              watermark: {
                text: watermarkText.value,
                tone: directiveTone.value,
                rotate: rotate.value,
                onPhase: pushDirectiveLog,
              },
            }}
            style={{
              marginTop: '12px',
              minHeight: '220px',
              padding: '18px 20px',
              borderRadius: '14px',
              border: '1px solid #8b5cf6',
              backgroundColor:
                directiveTone.value === 'violet'
                  ? 'rgba(30, 41, 59, 0.88)'
                  : 'rgba(15, 23, 42, 0.88)',
              color: '#f8fafc',
            }}
          >
            <p className="summary">
              registered name: <code>watermark</code>
            </p>
            <p className="empty">这个面板会被自定义指令重复铺上文字水印。</p>
            <p className="empty">dataset.watermark = {watermarkText.value}</p>
            <p className="empty">
              dataset.watermarkTone = {directiveTone.value}
            </p>
            <p className="empty">dataset.watermarkRotate = {rotate.value}deg</p>
          </div>
        </When>

        <Each
          value={directiveLog.value}
          fallback={renderEmpty('no directive logs')}
        >
          {(line: string): any => <p className="empty">{line}</p>}
        </Each>
      </div>
    </section>
  );
});
