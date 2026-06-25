/**
 * TSX 绑定名分析工具。
 *
 * 这个文件负责把 JSX/TSX 属性名归一化为编译器内部可消费的统一语义：
 * 1. 普通 prop，例如 `title`、`value`；
 * 2. DOM 事件与组件事件，例如 `onClick`、`onSubmit`、`on:close`；
 * 3. 扩展指令，例如 `model:value.trim`、`style:width.px`、`use:tooltip`。
 *
 * 上层模板解析器不会直接和原始属性名耦合，而是先调用这里完成分类，
 * 再决定应该写入 `attributes`、`events` 还是 `directives`。
 */
import ts from 'typescript';

// 修饰符字符串会一路透传到模板解析和运行时代码生成阶段，因此这里只做轻量约束。
export type EventModifier = 'stop' | 'prevent' | 'enter' | (string & {});
// 预处理阶段会把属性名中的 `.` 暂时转义，避免 TSX 解析器把它拆开。
const TSX_BINDING_DOT_ESCAPE = '__LANIA_DOT__';
export const DOM_EVENT_NAMES = new Set([
  'click',
  'input',
  'change',
  'keydown',
  'keyup',
  'submit',
  'focus',
  'blur',
  'pointerdown',
  'pointerup',
]);

export type TsxBindingKind =
  | 'prop'
  | 'dom-event'
  | 'component-event'
  | 'ref'
  | 'if-directive'
  | 'bind-directive'
  | 'model-directive'
  | 'html-directive'
  | 'class-directive'
  | 'style-object'
  | 'style-directive'
  | 'use-directive';

// 归一化结果会被模板解析器直接消费，因此这里的字段尽量贴近“可编译语义”而非 AST 细节。
export interface TsxBindingAnalysis {
  kind: TsxBindingKind;
  sourceName: string;
  bindingName: string;
  modifiers: EventModifier[];
  unit?: string;
}

export interface AnalyzeTsxBindingOptions {
  mode?: 'jsx-standard' | 'directive-extended';
  intrinsicElement?: boolean;
}

// 这组小工具负责先把 JSX 名字空间/转义占位符恢复成统一的绑定名文本。
// 扩展语法里的 DOM 事件名允许小写、短横线和命名空间风格片段。
const isPotentialDomEventName = (name: string): boolean => {
  return /^[a-z][a-z0-9:-]*$/.test(name);
};

export const getJsxAttributeNameText = (
  name: ts.JsxAttributeName
): string => {
  if (ts.isIdentifier(name)) {
    return name.text;
  }

  return `${name.namespace.text}:${name.name.text}`;
};

/** 将点号转义成占位符，便于先通过 TSX 词法解析。 */
export const escapeBindingNameForTsxParser = (name: string): string => {
  return name.includes('.') ? name.replace(/\./g, TSX_BINDING_DOT_ESCAPE) : name;
};

/** 将预处理阶段的占位符恢复为真实点号。 */
export const unescapeBindingNameFromTsxParser = (name: string): string => {
  return name.includes(TSX_BINDING_DOT_ESCAPE)
    ? name.replace(new RegExp(TSX_BINDING_DOT_ESCAPE, 'g'), '.')
    : name;
};

export const analyzeTsxBindingName = (
  name: string | ts.JsxAttributeName,
  options: AnalyzeTsxBindingOptions = {}
): TsxBindingAnalysis => {
  const mode = options.mode ?? 'jsx-standard';
  const intrinsicElement = options.intrinsicElement ?? false;
  const sourceName = unescapeBindingNameFromTsxParser(
    typeof name === 'string' ? name : getJsxAttributeNameText(name)
  );

  // 按最具体的语法前缀优先匹配，避免普通 prop 抢先吞掉指令语义。
  if (sourceName === 'ref') {
    return {
      kind: 'ref',
      sourceName,
      bindingName: 'ref',
      modifiers: [],
    };
  }

  if (sourceName === 'style') {
    return {
      kind: 'style-object',
      sourceName,
      bindingName: 'style',
      modifiers: [],
    };
  }

  // 扩展指令语法优先于普通 prop 处理，避免 `model:*`、`style:*` 等名字退化成字符串属性。
  if (mode === 'directive-extended' && sourceName === 'if') {
    return {
      kind: 'if-directive',
      sourceName,
      bindingName: 'if',
      modifiers: [],
    };
  }

  if (mode === 'directive-extended' && sourceName.startsWith('bind:')) {
    return {
      kind: 'bind-directive',
      sourceName,
      bindingName: sourceName.slice(5),
      modifiers: [],
    };
  }

  if (mode === 'directive-extended' && sourceName.startsWith('model:')) {
    const descriptor = sourceName.slice(6);
    const [bindingName, ...modifiers] = descriptor.split('.');

    return {
      kind: 'model-directive',
      sourceName,
      bindingName,
      modifiers: modifiers as EventModifier[],
    };
  }

  if (sourceName === 'model') {
    return {
      kind: 'model-directive',
      sourceName,
      bindingName: 'value',
      modifiers: [],
    };
  }

  if (sourceName === 'html') {
    return {
      kind: 'html-directive',
      sourceName,
      bindingName: 'html',
      modifiers: [],
    };
  }

  if (mode === 'directive-extended' && sourceName.startsWith('class:')) {
    return {
      kind: 'class-directive',
      sourceName,
      bindingName: sourceName.slice(6),
      modifiers: [],
    };
  }

  if (mode === 'directive-extended' && sourceName.startsWith('style:')) {
    const descriptor = sourceName.slice(6);
    const [bindingName, unit] = descriptor.split('.');

    return {
      kind: 'style-directive',
      sourceName,
      bindingName,
      modifiers: [],
      unit: unit || undefined,
    };
  }

  if (mode === 'directive-extended' && sourceName.startsWith('use:')) {
    return {
      kind: 'use-directive',
      sourceName,
      bindingName: sourceName.slice(4),
      modifiers: [],
    };
  }

  // 事件语法分成三层：显式 `on:*`、React 风格 `onXxx`、以及扩展模式下的小写事件名。
  if (sourceName.startsWith('on:')) {
    return {
      kind: 'component-event',
      sourceName,
      bindingName: sourceName.slice(3),
      modifiers: [],
    };
  }

  if (/^on[A-Z]/.test(sourceName)) {
    // React 风格 `onClick` 需要在这里继续区分成 DOM 事件还是组件事件。
    const eventName = sourceName.slice(2);
    const componentEventName = eventName.length > 0
      ? eventName[0]!.toLowerCase() + eventName.slice(1)
      : eventName;
    const domEventName = eventName.toLowerCase();

    // 标准 JSX 的 `onXxx` 在原生标签和组件标签上的含义不同，这里做一次分流。
    if (intrinsicElement) {
      return {
        kind: 'dom-event',
        sourceName,
        bindingName: domEventName,
        modifiers: [],
      };
    }

    return {
      kind: DOM_EVENT_NAMES.has(domEventName) ? 'dom-event' : 'component-event',
      sourceName,
      bindingName: DOM_EVENT_NAMES.has(domEventName) ? domEventName : componentEventName,
      modifiers: [],
    };
  }

  // DOM 事件支持 `click.stop.prevent` 这类修饰符后缀。
  const [eventCandidate, ...eventModifiers] = sourceName.split('.');

  if (mode === 'directive-extended' && DOM_EVENT_NAMES.has(sourceName)) {
    return {
      kind: 'dom-event',
      sourceName,
      bindingName: sourceName,
      modifiers: [],
    };
  }

  if (
    mode === 'directive-extended' &&
    eventModifiers.length > 0 &&
    isPotentialDomEventName(eventCandidate)
  ) {
    // 例如 `click.stop.prevent` 会被还原为 DOM 事件 + 修饰符列表。
    return {
      kind: 'dom-event',
      sourceName,
      bindingName: eventCandidate,
      modifiers: eventModifiers as EventModifier[],
    };
  }

  // 兜底保持为普通 prop，避免未知绑定名在分析阶段被误判成指令语义。
  return {
    kind: 'prop',
    sourceName,
    bindingName: sourceName,
    modifiers: [],
  };
};
