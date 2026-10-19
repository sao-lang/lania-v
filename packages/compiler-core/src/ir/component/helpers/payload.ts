import type { ElementNode } from '../../../ast';
import {
  ENHANCED_CONTRACT_PROTOCOL,
  ENHANCED_CONTRACT_VERSION,
  getDefaultBoundaryState,
  getEnhancedBlockPayloadKind,
  getEnhancedComponentMetadataPropNames,
  getEnhancedExecutableIrKind,
  type BoundaryPayloadComponentName,
  type EnhancedBlockPayloadKind,
  type EnhancedComponentName,
  type TransitionPayloadComponentName,
} from '@lania-v/shared';
import {
  getAttributeExpression,
  getAttributeStringValue,
  getElementAttributeEntries,
  renderStaticTemplateFromExpression,
} from './template-helpers';

/**
 * 增强组件 payload 构造辅助。
 *
 * 该文件负责把增强组件节点上的属性、事件、模板片段等信息，
 * 整理成一套可序列化、可嵌入到生成代码中的 payload 表达式。
 *
 * 它服务的场景主要有两类：
 * 1. Boundary / Suspense / Transition / KeepAlive / Teleport 等增强组件，
 *    需要把运行时协议数据下沉到 IR；
 * 2. 动态组件或增强 block 在运行时需要拿到一份“结构化 props + metadata + payload”。
 *
 * 核心难点在于：
 * - 有些值是静态字符串/布尔/数组；
 * - 有些值本身是一段运行时表达式，不能在编译期被 JSON 化；
 * - 有些元数据既可能来自 attribute，也可能来自事件形式的 `onXxx` 绑定。
 *
 * 所以这里先把值归一到 `PayloadExpressionValue`，最后再序列化成代码字符串。
 *
 * 可以把这层理解成“增强组件协议对象的最后装配站”：
 * - 上游 lowering 负责识别组件类型、模板和 slot；
 * - 本文件负责把这些结构化信息编码成运行时约定的 payload；
 * - 下游 codegen 只需要把返回的表达式字符串嵌入产物即可。
 */

const getEnhancedEventBackedMetadataPropNames = (
  name: string
): readonly string[] => {
  // 部分元数据属性既支持 `<Foo onEnter={...}>`，也支持事件声明形式，这里只挑事件型字段。
  return getEnhancedComponentMetadataPropNames(name).filter((propName) =>
    propName.startsWith('on')
  );
};

const getTransitionPayloadComponentConfig = (
  componentName: TransitionPayloadComponentName
): {
  phases: readonly ('appear' | 'enter' | 'move' | 'leave')[];
  keyPropName: 'transitionKey' | 'groupKey';
  tagPropName?: 'tag';
} => {
  // `Transition` 与 `TransitionGroup` 共享协议，但阶段集合和主键字段并不完全相同。
  return componentName === 'TransitionGroup'
    ? {
        phases: ['appear', 'enter', 'move', 'leave'],
        keyPropName: 'groupKey',
        tagPropName: 'tag',
      }
    : {
        phases: ['appear', 'enter', 'leave'],
        keyPropName: 'transitionKey',
      };
};

const isSuspenseBoundaryComponentName = (
  componentName: string
): componentName is 'Suspense' => {
  return componentName === 'Suspense';
};

const isErrorBoundaryComponentName = (
  componentName: string
): componentName is 'ErrorBoundary' => {
  return componentName === 'ErrorBoundary';
};

// 用一个品牌对象包裹“原样表达式”，避免被误当成普通字符串再做 JSON.stringify。
interface RawExpressionValue {
  readonly __rawExpression: string;
}

export type PayloadExpressionValue =
  | RawExpressionValue
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly PayloadExpressionValue[]
  | {
      readonly [key: string]: PayloadExpressionValue;
    };

const rawExpression = (expression: string): RawExpressionValue => {
  return {
    __rawExpression: expression,
  };
};

// 判断某个 payload 值是否是“需要原样拼回源码”的表达式占位。
const isRawExpressionValue = (
  value: PayloadExpressionValue
): value is RawExpressionValue => {
  return (
    typeof value === 'object' &&
    value !== null &&
    '__rawExpression' in value &&
    typeof value.__rawExpression === 'string'
  );
};

// 把 payload 值树重新编码成一段可嵌入生成代码的表达式字符串。
// 这里和 JSON.stringify 的差别在于：会保留 RawExpressionValue 对应的原始 JS 表达式。
export const serializePayloadExpressionValue = (value: PayloadExpressionValue): string => {
  if (isRawExpressionValue(value)) {
    return value.__rawExpression;
  }

  if (value === null) {
    return 'null';
  }

  if (value === undefined) {
    return 'undefined';
  }

  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    // 数组中的每个元素都可能继续包含 rawExpression，需要递归序列化。
    return `[${value.map((entry) => serializePayloadExpressionValue(entry)).join(', ')}]`;
  }

  const entries = Object.entries(value).flatMap(([key, entry]) => {
    if (entry === undefined) {
      // `undefined` 字段在生成对象字面量时直接省略，减少运行时代码噪音。
      return [];
    }

    return [`${JSON.stringify(key)}: ${serializePayloadExpressionValue(entry)}`];
  });

  return `{ ${entries.join(', ')} }`;
};

// 模板合同值：同时记录静态 html 和 hoist 名，供运行时按需选择模板来源。
export const buildTemplateContractValue = (
  html: string | undefined,
  hoist: string | undefined
): PayloadExpressionValue | undefined => {
  if (html === undefined && hoist === undefined) {
    return undefined;
  }

  return {
    html,
    hoist,
  };
};

// 从增强组件属性中读取一个字段，并保留“字符串值”和“原始表达式值”之间的区别。
const getPayloadFieldValue = (
  child: ElementNode,
  name: string
): PayloadExpressionValue | undefined => {
  const attribute = child.attributes.find((candidate) => candidate.name === name);

  if (!attribute || attribute.value === null) {
    return undefined;
  }

  if (typeof attribute.value === 'string') {
    return attribute.value;
  }

  return rawExpression(attribute.value.expression);
};

// 读取增强组件的 metadata 字段。
// 同一个字段可能来自：
// 1. 直接 attribute；
// 2. `onXxx` 形式的事件绑定；
// 3. 某些特定组件的额外推导值，例如 Suspense fallback 模板。
export const getEnhancedPayloadMetadataValue = (
  child: ElementNode,
  componentName: EnhancedComponentName
): PayloadExpressionValue => {
  const propNames = getEnhancedComponentMetadataPropNames(componentName);
  const metadata: Record<string, PayloadExpressionValue> = {};

  // 按协议声明的 metadata 字段逐个回填，缺失字段则保持省略，不强造默认值。
  propNames.forEach((name) => {
    const expression = getAttributeExpression(child, name);

    if (expression) {
      // 表达式值不能静态化时，保持为 rawExpression，留到运行时再求值。
      metadata[name] = rawExpression(expression);
      return;
    }

    if (getEnhancedEventBackedMetadataPropNames(componentName).includes(name)) {
      const eventName = name.slice(2);
      const normalizedEventName = eventName.length > 0
        ? `${eventName[0]!.toLowerCase()}${eventName.slice(1)}`
        : '';
      const event = child.events.find((candidate) => candidate.name === normalizedEventName);

      if (event?.expression) {
        // 事件回调也会被回填到 metadata 中，供增强组件运行时协议读取。
        metadata[name] = rawExpression(event.expression);
        return;
      }
    }

    const stringValue = getAttributeStringValue(child, name);

    if (stringValue !== null) {
      metadata[name] = stringValue;
    }
  });

  if (isSuspenseBoundaryComponentName(componentName)) {
    const fallbackExpression = getAttributeExpression(child, 'fallback');
    const fallbackTemplateHtml = fallbackExpression
      ? renderStaticTemplateFromExpression(fallbackExpression)
      : null;

    if (fallbackTemplateHtml) {
      // Suspense 的 fallback 若能静态展开，就直接把静态 HTML 带进 payload。
      metadata.fallback = fallbackTemplateHtml;
    }
  }

  return metadata;
};

export const getTransitionPayloadValue = (
  child: ElementNode,
  componentName: TransitionPayloadComponentName
): PayloadExpressionValue => {
  const transitionConfig = getTransitionPayloadComponentConfig(componentName);
  // 过渡钩子既支持裸阶段名，也支持 `onEnter` 这类回调形式，这里统一收集。
  const hookNames = transitionConfig.phases.flatMap((phase) => {
    const capitalizedPhase = `${phase[0]!.toUpperCase()}${phase.slice(1)}`;
    return [phase, `on${capitalizedPhase}`];
  });
  const hooks: Record<string, PayloadExpressionValue> = {};

  hookNames.forEach((name) => {
    const expression = getAttributeExpression(child, name);

    if (expression) {
      hooks[name] = rawExpression(expression);
      return;
    }

    if (name.startsWith('on')) {
      const eventName = name.slice(2);
      const normalizedEventName = eventName.length > 0
        ? `${eventName[0]!.toLowerCase()}${eventName.slice(1)}`
        : '';
      const event = child.events.find((candidate) => candidate.name === normalizedEventName);

      if (event?.expression) {
        hooks[name] = rawExpression(event.expression);
      }
    }
  });

  return {
    name: getPayloadFieldValue(child, 'name'),
    phases: transitionConfig.phases,
    keyProp: transitionConfig.keyPropName,
    key: (() => {
      // key 既可能来自表达式，也可能来自静态字符串，二者都要保留。
      const expression = getAttributeExpression(child, transitionConfig.keyPropName);
      if (expression) {
        return rawExpression(expression);
      }

      const stringValue = getAttributeStringValue(child, transitionConfig.keyPropName);
      return stringValue !== null ? stringValue : undefined;
    })(),
    // TransitionGroup 需要列表 key 才能判断 enter / move / leave；编译期把表达式原样带下去。
    keys: (() => {
      if (componentName !== 'TransitionGroup') {
        return undefined;
      }

      const expression = getAttributeExpression(child, 'keys');
      return expression ? rawExpression(expression) : undefined;
    })(),
    tag: transitionConfig.tagPropName
      ? getPayloadFieldValue(child, transitionConfig.tagPropName)
      : undefined,
    hooks: Object.keys(hooks).length > 0 ? hooks : undefined,
  };
};

// 组合运行时 props 表达式。
// 若用户显式提供 `props={...}`，则以它为基底，再和散落在 attribute 上的字段合并。
export const buildRuntimePropsExpression = (
  child: ElementNode,
  excludedAttributeNames: readonly string[] = []
): string => {
  const basePropsExpression = getAttributeExpression(child, 'props');
  const propEntries = getElementAttributeEntries(child, excludedAttributeNames);
  const explicitPropsExpression =
    propEntries.length > 0
      ? `{ ${propEntries.map(([name, value]) => `${JSON.stringify(name)}: ${value}`).join(', ')} }`
      : null;
  const eventExpression =
    child.events.length > 0
      ? `{
  "__lania_events": [
    ${child.events
      .map(
        (event) =>
          `{ name: ${JSON.stringify(event.name)}, handler: ${event.expression}, modifiers: ${JSON.stringify(event.modifiers)}${event.listener ? `, listener: ${JSON.stringify(event.listener)}` : ''} }`
      )
      .join(', ')}
  ]
}`
      : null;
  const directiveExpression =
    child.directives.length > 0
      ? `{
  "__lania_directives": [
    ${child.directives
      .map(
        (directive) =>
          `{ kind: ${JSON.stringify(directive.kind)}, name: ${JSON.stringify(directive.name)}, value: ${directive.expression}, modifiers: ${JSON.stringify(directive.modifiers)}, unit: ${directive.unit ? JSON.stringify(directive.unit) : 'undefined'} }`
      )
      .join(', ')}
  ]
}`
      : null;
  // 五个来源的优先级就是数组顺序：
  // 先用显式 `props` 与 spread 打底，再叠加散落 attribute、事件和指令描述。
  // 这里故意使用浅展开，保持运行时对象合并语义直观可预测。
  const spreadPropSources = (child.spreadAttributes ?? []).map(
    (expression) => `(${expression})`
  );
  const propSources = [
    basePropsExpression ? `(${basePropsExpression})` : null,
    ...spreadPropSources,
    explicitPropsExpression,
    eventExpression,
    directiveExpression,
  ].filter((value): value is string => value !== null);

  return propSources.length > 0
    ? `{ ${propSources.map((source) => `...(${source})`).join(', ')} }`
    : '{}';
};

export const buildKeepAlivePayloadExpression = (
  child: ElementNode,
  templateHtml: string,
  hoistName: string,
  slotIndex: number
): string => {
  const componentName = 'KeepAlive' as const;
  const metadata = getEnhancedPayloadMetadataValue(child, componentName) as {
    readonly [key: string]: PayloadExpressionValue;
  };
  const payloadKind = getEnhancedBlockPayloadKind(componentName);
  const executableIrKind = getEnhancedExecutableIrKind(componentName);
  const payload = {
    protocol: ENHANCED_CONTRACT_PROTOCOL,
    version: ENHANCED_CONTRACT_VERSION,
    payloadKind: payloadKind ?? ('cache' as EnhancedBlockPayloadKind),
    component: componentName,
    irKind: executableIrKind ?? 'KeepAliveIR',
    slotIndex,
    template: buildTemplateContractValue(templateHtml, hoistName),
    // cache 子对象只挑运行时 KeepAlive 协议真正消费的字段，避免 metadata 与主字段重复。
    cache: {
      scope: metadata.scope,
      key: metadata.cacheKey,
      max: metadata.max,
      include: metadata.include,
      exclude: metadata.exclude,
    },
    metadata,
  } satisfies PayloadExpressionValue;

  return serializePayloadExpressionValue(payload);
};

export const buildTransitionPayloadExpression = (
  child: ElementNode,
  componentName: TransitionPayloadComponentName,
  options: {
    transitionIndex: number;
    childTemplateHtml: string;
    fallbackTemplateHtml?: string;
  }
): string => {
  const metadata = getEnhancedPayloadMetadataValue(child, componentName);
  const executableIrKind = getEnhancedExecutableIrKind(componentName);

  if (String(executableIrKind) !== 'TransitionIR') {
    return '{}';
  }

  const transition = getTransitionPayloadValue(child, componentName);
  // 这些字段已经由 `transition` 主对象承载，metadata 里只保留额外协议信息，
  // 这样运行时读取 payload 时就不需要在两个位置之间做冲突裁决。
  const transitionMetadata =
    typeof metadata === 'object' && metadata !== null && !Array.isArray(metadata)
      ? Object.fromEntries(
          Object.entries(metadata).filter(
            ([key]) =>
              ![
                'name',
                'transitionKey',
                'groupKey',
                'tag',
                'enter',
                'leave',
                'appear',
                'move',
                'onEnter',
                'onLeave',
                'onAppear',
                'onMove',
              ].includes(key)
          )
        )
      : metadata;
  const transitionPayload = {
    protocol: ENHANCED_CONTRACT_PROTOCOL,
    version: ENHANCED_CONTRACT_VERSION,
    // 过渡块把模板合同和过渡配置拆开保存，便于运行时分别恢复结构与钩子。
    payloadKind: 'transition',
    component: componentName,
    irKind: executableIrKind,
    transitionIndex: options.transitionIndex,
    template: buildTemplateContractValue(options.childTemplateHtml, undefined),
    fallbackTemplate: buildTemplateContractValue(options.fallbackTemplateHtml, undefined),
    transition,
    metadata: transitionMetadata,
  } satisfies PayloadExpressionValue;

  return serializePayloadExpressionValue(transitionPayload);
};

export const buildBoundaryPayloadExpression = (
  child: ElementNode,
  componentName: BoundaryPayloadComponentName,
  options: {
    boundaryIndex: number;
    childTemplateHtml: string;
    fallbackTemplateHtml?: string;
  }
): string => {
  const metadata = getEnhancedPayloadMetadataValue(child, componentName);
  const executableIrKind = getEnhancedExecutableIrKind(componentName);

  if (executableIrKind !== 'BoundaryIR') {
    return '{}';
  }

  // ErrorBoundary 的 fallback 可能是 `(error) => <p>…</p>` 这类函数值，
  // 无法静态展开成模板，需要把表达式原样带给运行时，由 fallback 分支求值。
  const boundaryMetadata =
    isErrorBoundaryComponentName(componentName) &&
    options.fallbackTemplateHtml === undefined &&
    typeof metadata === 'object' &&
    metadata !== null &&
    !Array.isArray(metadata)
      ? (() => {
          const fallbackExpression = getAttributeExpression(child, 'fallback');
          return fallbackExpression
            ? {
                ...(metadata as Record<string, PayloadExpressionValue>),
                fallback: rawExpression(fallbackExpression),
              }
            : metadata;
        })()
      : metadata;

  const boundaryPayload = {
    protocol: ENHANCED_CONTRACT_PROTOCOL,
    version: ENHANCED_CONTRACT_VERSION,
    // Boundary payload 主要描述边界索引、初始状态与 children/fallback 两套模板合同。
    payloadKind: 'boundary',
    component: componentName,
    irKind: executableIrKind,
    boundaryIndex: options.boundaryIndex,
    initialState: getDefaultBoundaryState(componentName),
    childrenTemplate: buildTemplateContractValue(options.childTemplateHtml, undefined),
    fallbackTemplate: buildTemplateContractValue(options.fallbackTemplateHtml, undefined),
    metadata: boundaryMetadata,
  } satisfies PayloadExpressionValue;

  return serializePayloadExpressionValue(boundaryPayload);
};
