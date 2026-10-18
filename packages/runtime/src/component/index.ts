/**
 * 组件子模块公共入口。
 *
 * 这里不承载具体实现逻辑，职责主要是：
 * - 汇总函数组件、ReactiveElement、事件系统、样式工具与增强组件能力；
 * - 对外稳定暴露运行时组件 API，减少业务方感知内部目录拆分；
 * - 保持旧入口语义不变，即使内部实现已经迁移到 `host/`、`transition/` 等子目录。
 */
export * from './enhanced-components';
export * from './events';
export * from './host/prop-options';
export * from './host/reactive-element';
export * from './styles';
export * from './transition/runtime';
export type {
  BoundHandlers,
  BoundProps,
  ComponentElementConstructor,
  CreateComponentElementOptions,
  DefinedComponent,
  EnsureCustomElementOptions,
  FunctionComponent,
  FunctionLifecycleCallback,
  LazyComponent,
  LazyResolvedModule,
  Root,
  SlotBindings,
} from './host/function-component';
export {
  bindHandlers,
  bindProps,
  bindSlots,
  createExpose,
  createComponentElement,
  createComponentPropsSnapshot,
  createRoot,
  defineComponent,
  getComponentCreationProps,
  getComponentTagName,
  isComponentElementConstructor,
  lazy,
  mountComponent,
  onCleanup,
  onMounted,
  onMount,
  onUnmounted,
  onUpdated,
  useContext,
  useFormValidity,
  useFormValue,
} from './host/function-component';
