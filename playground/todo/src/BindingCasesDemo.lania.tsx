import {
  createMemo,
  createSignal,
  defineComponent,
  html,
} from '@lania-v/runtime';

export default defineComponent(function BindingCasesDemo() {
  const modelTitle = createSignal('Lania Binding Demo');
  const modelWidth = createSignal(320);
  const modelReady = createSignal(true);

  const htmlTitle = createSignal('Raw HTML Preview');
  const htmlTone = createSignal<'violet' | 'emerald'>('violet');
  const htmlContent = createMemo(() => {
    const badge =
      htmlTone.value === 'violet'
        ? '<span style="color:#7c3aed;">violet</span>'
        : '<span style="color:#059669;">emerald</span>';
    return html`
      <div>
        <p><strong>${htmlTitle.value}</strong></p>
        <p>tone: ${badge}</p>
      </div>
    `;
  });

  const classCompact = createSignal(false);
  const classReady = createSignal(true);
  const classTone = createSignal<'violet' | 'emerald'>('violet');
  const classPreview = createMemo(() => [
    'surface-light',
    'binding-case-card',
    `binding-case-card--${classTone.value}`,
    {
      'binding-case-card--compact': classCompact.value,
      'binding-case-card--ready': classReady.value,
    },
  ]);

  const styleWidth = createSignal(300);
  const stylePadding = createSignal(18);
  const styleTone = createSignal<'violet' | 'emerald'>('violet');
  const stylePreview = createMemo(() => [
    'margin-top: 12px;',
    {
      width: `${styleWidth.value}px`,
      padding: `${stylePadding.value}px`,
      borderRadius: '14px',
      border: '1px solid rgba(148, 163, 184, 0.45)',
      background:
        styleTone.value === 'violet'
          ? 'linear-gradient(180deg, #ffffff, #f5f3ff)'
          : 'linear-gradient(180deg, #ffffff, #ecfdf5)',
      boxShadow:
        styleTone.value === 'violet'
          ? '0 12px 32px rgba(124, 58, 237, 0.12)'
          : '0 12px 32px rgba(16, 185, 129, 0.12)',
    },
  ]);

  return (
    <section className="todo-card">
      <header>
        <h3>Binding Cases Demo</h3>
        <p className="summary">
          把 <code>model</code>、<code>html</code>、<code>class</code>、
          <code>style</code> 分成 4 个独立 case。
        </p>
      </header>

      <div className="list">
        <div className="item">
          <p className="summary">Case 1: model</p>
          <p className="empty">
            同时演示 text / number / checked 三种常见绑定入口。
          </p>
          <div className="row">
            <input
              className="input"
              model={{ target: modelTitle, modifiers: { trim: true } }}
              placeholder="editor title"
            />
            <input
              className="input"
              type="number"
              min="240"
              max="420"
              step="20"
              model={{ target: modelWidth, modifiers: { number: true } }}
            />
            <label className="empty">
              <input
                model={{ target: modelReady, prop: 'checked' }}
                type="checkbox"
              />{' '}
              ready
            </label>
          </div>
          <p className="empty">
            snapshot: title={modelTitle.value} | width={modelWidth.value} |
            ready=
            {String(modelReady.value)}
          </p>
        </div>

        <div className="item">
          <p className="summary">Case 2: html</p>
          <p className="empty">
            使用 <code>html``</code> 显式构造原始 HTML，再通过 <code>html</code>{' '}
            指令写入
            <code>innerHTML</code>。
          </p>
          <div className="row">
            <input
              className="input"
              value={htmlTitle.value}
              onInput={(event: Event) => {
                const target = event.target as HTMLInputElement | null;
                htmlTitle.set(target?.value || 'Raw HTML Preview');
              }}
              placeholder="html title"
            />
            <button
              className="btn"
              onClick={() =>
                htmlTone.set((value) =>
                  value === 'violet' ? 'emerald' : 'violet'
                )
              }
            >
              tone: {htmlTone.value}
            </button>
          </div>
          <div
            className="surface-light"
            style={{
              marginTop: '12px',
              padding: '16px 18px',
              borderRadius: '14px',
              border: '1px solid rgba(148, 163, 184, 0.35)',
              background: '#ffffff',
            }}
          >
            <article html={htmlContent.value} />
          </div>
        </div>

        <div className="item">
          <p className="summary">Case 3: class</p>
          <p className="empty">
            这里把字符串、数组、对象组合成一个最终 className。
          </p>
          <div className="row">
            <button
              className="btn"
              onClick={() => classCompact.set((value) => !value)}
            >
              compact: {String(classCompact.value)}
            </button>
            <button
              className="btn"
              onClick={() => classReady.set((value) => !value)}
            >
              ready: {String(classReady.value)}
            </button>
            <button
              className="btn"
              onClick={() =>
                classTone.set((value) =>
                  value === 'violet' ? 'emerald' : 'violet'
                )
              }
            >
              tone: {classTone.value}
            </button>
          </div>
          <div
            className={classPreview.value}
            style={{
              marginTop: '12px',
              padding: '18px 20px',
              borderRadius: '14px',
              border: '1px solid rgba(148, 163, 184, 0.35)',
              background: '#ffffff',
            }}
          >
            <p className="summary">class preview</p>
            <p className="empty">
              className = ['surface-light', 'binding-case-card',
              `binding-case-card--tone`,
              {'{'} compact, ready {'}'}]
            </p>
          </div>
        </div>

        <div className="item">
          <p className="summary">Case 4: style</p>
          <p className="empty">
            这里把字符串、数组、对象组合成一个最终 style 值。
          </p>
          <div className="row">
            <button
              className="btn"
              onClick={() => styleWidth.set((value) => value + 20)}
            >
              width +20
            </button>
            <button
              className="btn"
              onClick={() =>
                stylePadding.set((value) => (value === 18 ? 12 : 18))
              }
            >
              padding: {stylePadding.value}
            </button>
            <button
              className="btn"
              onClick={() =>
                styleTone.set((value) =>
                  value === 'violet' ? 'emerald' : 'violet'
                )
              }
            >
              tone: {styleTone.value}
            </button>
          </div>
          <div className="surface-light" style={stylePreview.value}>
            <p className="summary">style preview</p>
            <p className="empty">
              style = ['margin-top: 12px;', {'{'} width: '{styleWidth.value}px',
              padding: '{stylePadding.value}px' {'}'}]
            </p>
          </div>
        </div>
      </div>
    </section>
  );
});
