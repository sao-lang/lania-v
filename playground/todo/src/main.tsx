import { createRoot, css } from '@lania-v/runtime';
import FcBindingApiDemo from './FcBindingApiDemo.lania.tsx';
import FcShowcase from './FcShowcase.lania.tsx';
import LocalStateCounterCard from './LocalStateCounterCard.lania.tsx';
import ShowcaseCard from './ShowcaseCard.lania.tsx';
import TodoFc from './TodoFc.lania.tsx';

// Prefer component-scoped styles so they work in both shadow + light render modes.
const sharedStyles = css`
  :host {
    display: block;
    color: rgba(255, 255, 255, 0.92);
    font-family:
      ui-sans-serif,
      system-ui,
      -apple-system,
      Segoe UI,
      Roboto,
      Helvetica,
      Arial;
  }

  * {
    box-sizing: border-box;
  }

  button,
  input {
    font: inherit;
  }

  .todo-card {
    border-radius: 16px;
    padding: 16px;
    border: 1px solid rgba(255, 255, 255, 0.12);
    background: linear-gradient(
      180deg,
      rgba(255, 255, 255, 0.08),
      rgba(255, 255, 255, 0.05)
    );
    box-shadow: 0 14px 44px rgba(0, 0, 0, 0.42);
    backdrop-filter: blur(10px);
  }

  .todo-card header h3 {
    margin: 0 0 8px;
    font-size: 16px;
    letter-spacing: 0.2px;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }

  .filters {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin: 12px 0 0;
  }

  .chip {
    border: 1px solid rgba(255, 255, 255, 0.14);
    background: rgba(255, 255, 255, 0.06);
    color: rgba(255, 255, 255, 0.9);
    padding: 8px 12px;
    border-radius: 999px;
    cursor: pointer;
    font-size: 12px;
    line-height: 1;
    transition:
      transform 70ms ease,
      background 140ms ease,
      border-color 140ms ease;
    user-select: none;
  }

  .chip:hover {
    background: rgba(255, 255, 255, 0.09);
    border-color: rgba(255, 255, 255, 0.2);
  }

  .chip[aria-pressed='true'] {
    border-color: rgba(139, 92, 246, 0.6);
    background: rgba(139, 92, 246, 0.22);
  }

  .chip:active {
    transform: translateY(1px);
  }

  .btn {
    border: 1px solid rgba(255, 255, 255, 0.14);
    background: linear-gradient(
      180deg,
      rgba(139, 92, 246, 0.95),
      rgba(124, 58, 237, 0.95)
    );
    color: rgba(255, 255, 255, 0.92);
    padding: 10px 12px;
    border-radius: 12px;
    cursor: pointer;
    font-size: 12px;
    transition:
      filter 140ms ease,
      transform 70ms ease,
      box-shadow 140ms ease;
    user-select: none;
    box-shadow: 0 10px 26px rgba(124, 58, 237, 0.25);
  }

  .btn:hover {
    filter: brightness(1.06);
    box-shadow: 0 12px 32px rgba(124, 58, 237, 0.32);
  }

  .btn:active {
    transform: translateY(1px);
  }

  .danger {
    border-color: rgba(248, 113, 113, 0.55);
    background: linear-gradient(
      180deg,
      rgba(248, 113, 113, 0.95),
      rgba(239, 68, 68, 0.95)
    );
    box-shadow: 0 10px 26px rgba(239, 68, 68, 0.22);
  }

  .input {
    min-width: 200px;
    padding: 10px 12px;
    border-radius: 12px;
    border: 1px solid rgba(255, 255, 255, 0.16);
    background: rgba(255, 255, 255, 0.05);
    color: rgba(255, 255, 255, 0.92);
    transition:
      border-color 140ms ease,
      box-shadow 140ms ease,
      background 140ms ease;
  }

  .input:hover {
    background: rgba(255, 255, 255, 0.065);
  }

  .input:focus {
    outline: none;
    border-color: rgba(139, 92, 246, 0.65);
    box-shadow: 0 0 0 4px rgba(139, 92, 246, 0.22);
  }

  .input::placeholder {
    color: rgba(255, 255, 255, 0.35);
  }

  .list {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin-top: 12px;
  }

  .item {
    border: 1px solid rgba(255, 255, 255, 0.1);
    background: rgba(255, 255, 255, 0.04);
    border-radius: 14px;
    padding: 12px;
  }

  .done {
    text-decoration: line-through;
    color: rgba(255, 255, 255, 0.55);
  }

  .footer {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 10px;
    margin-top: 10px;
  }

  .summary {
    margin: 0;
    color: rgba(255, 255, 255, 0.7);
    font-size: 12px;
  }

  .empty {
    margin: 0;
    color: rgba(255, 255, 255, 0.55);
    font-size: 12px;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .surface-light {
    color: rgba(15, 23, 42, 0.92);
  }

  .surface-light .summary {
    color: rgba(15, 23, 42, 0.82);
  }

  .surface-light .empty {
    color: rgba(15, 23, 42, 0.72);
  }

  .surface-light .input {
    border-color: rgba(15, 23, 42, 0.18);
    background: rgba(15, 23, 42, 0.04);
    color: rgba(15, 23, 42, 0.92);
  }

  .surface-light .input::placeholder {
    color: rgba(15, 23, 42, 0.45);
  }
`;

(
  [
    FcBindingApiDemo,
    FcShowcase,
    TodoFc,
    ShowcaseCard,
    LocalStateCounterCard,
  ] as Array<CustomElementConstructor & { styles?: unknown }>
).forEach((component) => {
  component.styles = sharedStyles;
});

const App = () => {
  return (
    <div
      style={{
        padding: '20px',
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
        gap: '20px',
        maxWidth: '1100px',
        margin: '0 auto',
      }}
    >
      <FcBindingApiDemo />
      <FcShowcase />
    </div>
  );
};

const root = document.querySelector('#app');

if (root) {
  createRoot(root).render((<App />) as unknown as Node);
}
