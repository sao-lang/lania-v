import { createRoot, registerRuntimeDebugHooks } from '@lania-v/runtime';
import LoginPage from './LoginPage.lania.tsx';
import { loginStyles } from './login-styles';

if (import.meta.env.DEV) {
  const stopRuntimeTrace = registerRuntimeDebugHooks({
    onSignalEvent(event) {
      console.log('[lania-v] Signal.set', { signalId: event.signalId });
    },
    onSchedulerEvent(event) {
      console.log(`[lania-v] Scheduler.${event.type}`, {
        priority: event.priority,
        queueSize: event.queueSize,
      });
    },
    onDevtoolsEvent(event) {
      if (event.type === 'updater-run') {
        console.log('[lania-v] Updater.run', event.payload);
      } else if (event.type === 'slot-write') {
        console.log('[lania-v] Slot.write', event.payload);
      }
    },
  });
  import.meta.hot?.dispose(stopRuntimeTrace);
}

// 样式挂在组件构造器上，由 ReactiveElement 注入到组件自己的 shadow root。
LoginPage.styles = loginStyles;

const OBSERVE_OPTIONS: MutationObserverInit = {
  childList: true,
  subtree: true,
  attributes: true,
  characterData: true,
  attributeOldValue: true,
  characterDataOldValue: true,
};

const describeElement = (element: Element): string => {
  const parts = [element.tagName.toLowerCase()];
  if (element.id) parts.push(`#${element.id}`);

  const className = element.getAttribute('class');
  if (className) parts.push(`.${className.trim().split(/\s+/).join('.')}`);

  const name = element.getAttribute('name');
  if (name) parts.push(`[name=${name}]`);

  return parts.join('');
};

const describeNode = (node: Node): string => {
  if (node instanceof Element) return describeElement(node);
  if (node.nodeType === Node.TEXT_NODE) return `#text(${JSON.stringify(node.nodeValue)})`;
  return node.nodeName;
};

const describeTarget = (target: Node): string => {
  if (target.nodeType === Node.TEXT_NODE) {
    const parent = target.parentElement;
    return parent ? `#text in ${describeElement(parent)}` : '#text';
  }
  return target instanceof Element ? describeElement(target) : target.nodeName;
};

const formatMutation = (record: MutationRecord): string => {
  const label = describeTarget(record.target);

  if (record.type === 'attributes') {
    const attributeName = record.attributeName ?? '';
    const next = (record.target as Element).getAttribute(attributeName);
    return `attributes  ${label}  ${attributeName}: ${record.oldValue ?? 'null'} -> ${next ?? 'null'}`;
  }

  if (record.type === 'characterData') {
    return `text        ${label}  ${JSON.stringify(record.oldValue)} -> ${JSON.stringify(record.target.nodeValue)}`;
  }

  const added = [...record.addedNodes].map(describeNode).join(', ') || '-';
  const removed = [...record.removedNodes].map(describeNode).join(', ') || '-';
  return `childList   ${label}  +[${added}] -[${removed}]`;
};

// MutationObserver 不会跨 shadow root，所以这里把每个 shadow root 也纳入观察范围。
const observeDeep = (root: Node, callback: (record: MutationRecord) => void): MutationObserver => {
  function attach(node: Node): void {
    observer.observe(node, OBSERVE_OPTIONS);
    if (node instanceof Element && node.shadowRoot) {
      attach(node.shadowRoot);
    }
  }

  const observer = new MutationObserver((records) => {
    records.forEach((record) => {
      // 运行期新插入的元素可能自带 shadow root，需要补挂观察。
      record.addedNodes.forEach((node) => {
        if (!(node instanceof Element)) return;
        if (node.shadowRoot) attach(node.shadowRoot);
        node.querySelectorAll('*').forEach((child) => {
          if (child.shadowRoot) attach(child.shadowRoot);
        });
      });
      callback(record);
    });
  });

  attach(root);

  const walk = (node: Node): void => {
    node.childNodes.forEach((child) => {
      if (child instanceof Element) {
        if (child.shadowRoot) attach(child.shadowRoot);
        walk(child);
      }
    });
  };
  walk(root);

  return observer;
};

const App = () => {
  return (
    <div className="app-shell">
      <div>
        <LoginPage />
        <p className="app-footnote">
          页面由 <code>LoginPage.lania.tsx</code> 编译产出，无 Virtual DOM、无整树 diff
        </p>
      </div>
    </div>
  );
};

const root = document.querySelector('#app');

if (root) {
  createRoot(root).render(<App /> as unknown as Node);

  // 挂载完成后再安装，确保 login-page 的 shadow root 已经存在。
  observeDeep(document.body, (record) => {
    console.log('[mutation]', formatMutation(record));
  });
}
