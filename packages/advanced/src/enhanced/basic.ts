/**
 * 提供增强组件语法糖的基础实现。
 *
 * 这些导出本身不保存状态，只负责把 JSX/模板传入的 props
 * 转交给兼容层渲染函数，便于编译产物和手写组件复用同一套语义。
 */
import { defineEnhancedComponent, asEachDefinition } from './utils/factory';
import {
  renderCompatChildren,
  renderCompatDynamic,
  renderCompatEach,
  renderCompatSlot,
  renderCompatWhen,
} from './utils/compat';
import type {
  CaseProps,
  DynamicProps,
  EachProps,
  EnhancedRenderable,
  ElseProps,
  FragmentProps,
  SlotProps,
  DefaultProps,
  SwitchProps,
  TeleportProps,
  ThenProps,
  WhenProps,
} from './types';

// `When` 根据条件在主内容和 fallback 之间切换。
export const When = defineEnhancedComponent(
  'When',
  (props: WhenProps): EnhancedRenderable => {
    return renderCompatWhen(props);
  }
);

// `Then`/`Else`/`Case`/`Default` 只是结构化容器，直接透传子内容。
export const Then = defineEnhancedComponent(
  'Then',
  (props: ThenProps): EnhancedRenderable => {
    return renderCompatChildren(props.children);
  }
);

export const Else = defineEnhancedComponent(
  'Else',
  (props: ElseProps): EnhancedRenderable => {
    return renderCompatChildren(props.children);
  }
);

export const Switch = defineEnhancedComponent(
  'Switch',
  (props: SwitchProps): EnhancedRenderable => {
    return renderCompatChildren(props.children);
  }
);

export const Case = defineEnhancedComponent(
  'Case',
  (props: CaseProps): EnhancedRenderable => {
    return renderCompatChildren(props.children);
  }
);

export const Default = defineEnhancedComponent(
  'Default',
  (props: DefaultProps): EnhancedRenderable => {
    return renderCompatChildren(props.children);
  }
);

// `Each` 额外保留泛型签名，供消费侧拿到 item/index 的精确类型。
export const Each = asEachDefinition<EnhancedRenderable>(
  defineEnhancedComponent(
    'Each',
    (props: EachProps<unknown>): EnhancedRenderable => {
      return renderCompatEach(props);
    }
  )
);

export const Teleport = defineEnhancedComponent(
  'Teleport',
  (props: TeleportProps): EnhancedRenderable => {
    return renderCompatChildren(props.children);
  }
);

export const Fragment = defineEnhancedComponent(
  'Fragment',
  (props: FragmentProps): EnhancedRenderable => {
    return renderCompatChildren(props.children);
  }
);

// `Slot` 和 `Dynamic` 需要进入兼容层解析运行时上下文。
export const Slot = defineEnhancedComponent(
  'Slot',
  (props: SlotProps): EnhancedRenderable => {
    return renderCompatSlot(props);
  }
);

export const Dynamic = defineEnhancedComponent(
  'Dynamic',
  (props: DynamicProps): EnhancedRenderable => {
    return renderCompatDynamic(props);
  }
);
