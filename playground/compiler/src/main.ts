import { compileFunctionComponentTsx } from '@lania-v/compiler-tsx';

const source = `
const CounterCard = defineComponent((props: { title: string }) => {
  const count = createSignal(1);
  return (
    <section className="counter-card">
      <h1>{props.title}</h1>
      <p>Count: <span>{count()}</span></p>
    </section>
  );
});
`.trim();

const result = compileFunctionComponentTsx('CounterCard.tsx', source);

const root = document.querySelector('#app');

if (root) {
  const container = document.createElement('main');
  const title = document.createElement('h1');
  const sourceTitle = document.createElement('h2');
  const htmlTitle = document.createElement('h2');
  const astTitle = document.createElement('h2');
  const irTitle = document.createElement('h2');
  const depsTitle = document.createElement('h2');
  const slotsTitle = document.createElement('h2');
  const updatersTitle = document.createElement('h2');
  const classCodeTitle = document.createElement('h2');
  const bindingsTitle = document.createElement('h2');
  const renderTitle = document.createElement('h2');
  const sourceBlock = document.createElement('pre');
  const htmlBlock = document.createElement('pre');
  const astBlock = document.createElement('pre');
  const irBlock = document.createElement('pre');
  const depsBlock = document.createElement('pre');
  const slotsBlock = document.createElement('pre');
  const updatersBlock = document.createElement('pre');
  const classCodeBlock = document.createElement('pre');
  const bindingsBlock = document.createElement('pre');
  const renderBlock = document.createElement('pre');

  container.setAttribute(
    'style',
    [
      'font-family: ui-monospace, SFMono-Regular, Menlo, monospace',
      'padding: 24px',
      'line-height: 1.5',
      'max-width: 960px',
      'margin: 0 auto',
    ].join('; ')
  );

  title.textContent = 'Compiler playground';
  sourceTitle.textContent = 'Input TSX';
  htmlTitle.textContent = 'Static HTML';
  astTitle.textContent = 'Program AST';
  irTitle.textContent = 'Component IR';
  depsTitle.textContent = 'Dependency Analysis';
  slotsTitle.textContent = 'Slot Allocation';
  updatersTitle.textContent = 'Updater Generation';
  classCodeTitle.textContent = 'Generated Component Code';
  bindingsTitle.textContent = 'Text bindings';
  renderTitle.textContent = 'Generated _renderAndMount()';

  sourceBlock.textContent = source;
  htmlBlock.textContent = result.staticHtml;
  astBlock.textContent = JSON.stringify(result.componentAst, null, 2);
  irBlock.textContent = JSON.stringify(result.ir, null, 2);
  depsBlock.textContent = JSON.stringify(result.ir.dependencyAnalysis, null, 2);
  slotsBlock.textContent = JSON.stringify(result.ir.slotAllocation, null, 2);
  updatersBlock.textContent = JSON.stringify(
    result.ir.updaterGeneration,
    null,
    2
  );
  classCodeBlock.textContent = result.classCode.code;
  bindingsBlock.textContent = JSON.stringify(result.textBindings, null, 2);
  renderBlock.textContent = result.renderCode.code;

  container.append(
    title,
    sourceTitle,
    sourceBlock,
    htmlTitle,
    htmlBlock,
    astTitle,
    astBlock,
    irTitle,
    irBlock,
    depsTitle,
    depsBlock,
    slotsTitle,
    slotsBlock,
    updatersTitle,
    updatersBlock,
    classCodeTitle,
    classCodeBlock,
    bindingsTitle,
    bindingsBlock,
    renderTitle,
    renderBlock
  );
  root.replaceChildren(container);
}
