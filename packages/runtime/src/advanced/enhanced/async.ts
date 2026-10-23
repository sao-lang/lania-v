/**
 * 增强异步边界组件封装。
 *
 * 该文件把 `LazyLoad`、`ErrorBoundary`、`Suspense` 三类声明式组件统一映射到
 * 运行时 boundary host / registry 能识别的 payload 与渲染入口上，职责主要包括：
 * - 根据 props 生成或复用共享协议要求的 boundary payload；
 * - 从当前上下文读取父级 boundary host，维持嵌套边界关系；
 * - 把 children / fallback 规范化为可渲染值，再交给边界注册表执行。
 */
import {
  createErrorBoundaryHost,
  createLazyBoundaryHost,
  createSuspenseBoundaryHost,
  readContextBoundaryHost,
} from '../../component/lifecycle';
import {
  ENHANCED_CONTRACT_PROTOCOL,
  ENHANCED_CONTRACT_VERSION,
  type BoundaryPayload,
} from '@lania-v/shared';
import {
  executeErrorBoundary,
  executeLazyBoundary,
  executeSuspenseBoundary,
  resolveErrorBoundaryFallback,
} from '../../component/lifecycle';
import { defineEnhancedComponent } from './utils/factory';
import {
  asRenderable,
  getRenderableElements,
  invokeRenderable,
} from './utils/renderable';
import type {
  EnhancedRenderable,
  ErrorBoundaryProps,
  LazyLoadProps,
  SuspenseProps,
} from './types';

const createBoundaryPayload = (
  component: BoundaryPayload['component'],
  metadata: Record<string, unknown>
): BoundaryPayload => {
  // 统一补齐增强组件协议字段，避免每个组件各自拼接 payload 结构。
  return {
    protocol: ENHANCED_CONTRACT_PROTOCOL,
    version: ENHANCED_CONTRACT_VERSION,
    payloadKind: 'boundary',
    component,
    irKind: 'BoundaryIR',
    boundaryIndex: 0,
    initialState: component === 'LazyLoad' ? 'inactive' : 'idle',
    childrenTemplate: {},
    metadata,
  };
};

const resolveLazyPayload = (props: LazyLoadProps): BoundaryPayload => {
  return (
    props.payload ??
    // 未显式传 payload 时，从组件 props 推导出 runtime 可消费的默认元数据。
    createBoundaryPayload('LazyLoad', {
      lazyKey: props.lazyKey,
      rootMargin: props.rootMargin,
      once: props.once,
      observe: props.observe,
    })
  );
};

const resolveErrorPayload = (props: ErrorBoundaryProps): BoundaryPayload => {
  return (
    props.payload ??
    createBoundaryPayload('ErrorBoundary', {
      boundaryKey: props.boundaryKey,
    })
  );
};

const resolveSuspensePayload = (props: SuspenseProps): BoundaryPayload => {
  return (
    props.payload ??
    createBoundaryPayload('Suspense', {
      suspenseKey: props.suspenseKey,
    })
  );
};

export const LazyLoad = defineEnhancedComponent(
  'LazyLoad',
  (props: LazyLoadProps): EnhancedRenderable => {
    const rendered = invokeRenderable(asRenderable(props.children));
    const boundaryHost = readContextBoundaryHost();
    const renderedTarget = getRenderableElements(rendered)[0];
    return executeLazyBoundary<EnhancedRenderable>({
      payload: resolveLazyPayload(props),
      host: createLazyBoundaryHost<EnhancedRenderable>({
        boundary: boundaryHost,
        // 外部传 target 时优先复用；否则退回到首个实际渲染元素作为可见性观测目标。
        observeInvisibleTarget: props.target ?? undefined,
        observeVisibleTarget: props.target ?? renderedTarget ?? undefined,
        observeWhileVisible: true,
        renderChild: () => rendered as EnhancedRenderable,
        // LazyLoad fallback 会额外插入 sentinel，供后续可见性切换重新接管。
        renderFallback: (sentinel) =>
          [
            sentinel,
            invokeRenderable(props.fallback),
          ] as unknown as EnhancedRenderable,
        onVisibleChange: props.onVisibleChange,
      }),
    });
  }
);

export const ErrorBoundary = defineEnhancedComponent(
  'ErrorBoundary',
  (props: ErrorBoundaryProps): EnhancedRenderable => {
    const boundaryHost = readContextBoundaryHost();
    return executeErrorBoundary<EnhancedRenderable>({
      payload: resolveErrorPayload(props),
      host: createErrorBoundaryHost<EnhancedRenderable>({
        boundary: boundaryHost,
        renderChild: () =>
          invokeRenderable(asRenderable(props.children)) as EnhancedRenderable,
        // fallback 既支持静态节点，也支持依赖 error / reset 的函数式回退内容。
        renderFallback: (error, reset) =>
          invokeRenderable(
            asRenderable(
              resolveErrorBoundaryFallback({
                error,
                fallback: props.fallback,
                reset,
              })
            )
          ) as EnhancedRenderable,
        onError: props.onError,
        onReset: props.onReset,
      }),
    });
  }
);

export const Suspense = defineEnhancedComponent(
  'Suspense',
  (props: SuspenseProps): EnhancedRenderable => {
    const boundaryHost = readContextBoundaryHost();
    return executeSuspenseBoundary<EnhancedRenderable>({
      payload: resolveSuspensePayload(props),
      host: createSuspenseBoundaryHost<EnhancedRenderable>({
        boundary: boundaryHost,
        // 子内容与 fallback 都在这里被标准化，保证 registry 处理的是统一 renderable 结果。
        renderChild: () =>
          invokeRenderable(asRenderable(props.children)) as EnhancedRenderable,
        renderFallback: () =>
          invokeRenderable(props.fallback) as EnhancedRenderable,
        onPending: props.onPending,
        onResolve: props.onResolve,
        onReject: props.onReject,
      }),
    });
  }
);
