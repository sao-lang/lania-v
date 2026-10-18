import { createComponentElement } from '@lania-v/runtime';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import MouseTracker from './MouseTracker.lania.tsx';

const mouseTagName = createComponentElement(MouseTracker).tagName.toLowerCase();

const MouseDemo = () => {
  return createElement('main', { className: 'mouse-page' }, [
    createElement('header', { className: 'mouse-page-header', key: 'header' }, [
      createElement(
        'p',
        { className: 'mouse-overline', key: 'overline' },
        'playground example'
      ),
      createElement(
        'h1',
        { key: 'title' },
        'Using a lania-v component in React'
      ),
      createElement(
        'p',
        { key: 'description' },
        'The mouse tracker is compiled by lania-v and mounted as a custom element inside this React page.'
      ),
    ]),
    createElement(mouseTagName, { className: 'mouse-react-host', key: 'host' }),
    createElement(
      'p',
      { className: 'mouse-page-note', key: 'note' },
      'useMouse uses createSignal and createEffect; the Lania component attaches and removes its listeners with onMount and onCleanup.'
    ),
  ]);
};

const root = document.querySelector('#root');

if (!root) {
  throw new Error('Mouse playground root container was not found.');
}

createRoot(root).render(createElement(MouseDemo, {}));
