/**
 * 提供 TransitionGroup host runtime 的骨架实现。
 *
 * 这个 scaffold 的职责是先拼出一份“接口完整但行为可占位”的 runtime：
 * - key 解析、commit 入口、renderEntries 这类通用能力在这里直接提供；
 * - state 发布、visible commit、previous commit、context 构造等宿主相关能力，
 *   则延后由具体 host 模式在绑定阶段注入。
 *
 * 这样不同运行形态可以复用同一套对外协议，只替换底层状态承载与提交细节。
 */
import {
  bindCommitFlowRuntime,
  bindCommitStateRuntime,
  bindPrevCommitStateRuntime,
  type GroupCommitResult,
  type GroupPrevCommitContext,
  type GroupPrevCommitResult,
} from '../render/visible';
import { type GroupCommitPublishInput } from '../state/state';
import {
  bindStateKeyRuntime,
  commitByIntent,
  createPlaceholderCommit,
  createPlaceholderKeys,
} from '../state/state';
import { bindPrevCommitRuntime } from './commit-runtime';
import { type BasePrevApplier } from '../../runtime';
import type {
  GroupCommitInput,
  GroupRuntimeCore,
  TransitionGroupRuntime,
  TransitionGroupState,
} from '../types';
import type { GroupPlaceholderCommitRuntime } from '../state/state';

type GroupScaffoldRuntime<
  TRenderable,
  TVisibleContext,
  TVisibleResult extends TRenderable[] | HTMLElement,
  TPreviousResult extends TRenderable[] | HTMLElement | null,
> = GroupRuntimeCore<TRenderable> &
  Pick<
    TransitionGroupRuntime<TRenderable>,
    | 'getPrevious'
    | 'summarizePrevious'
    | 'resolveCommitIntent'
    | 'resolvePrevious'
    | 'commit'
    | 'commitVisible'
  > &
  GroupPlaceholderCommitRuntime<
    TRenderable,
    TVisibleContext,
    TVisibleResult,
    TPreviousResult
  > & {
    createContext(options: {
      keys: readonly PropertyKey[];
      rendered: readonly TRenderable[];
      previous: TransitionGroupState<TRenderable> | undefined;
    }): TVisibleContext;
  };

// scaffold 只依赖 key 解析和可选的条目重整逻辑，其余能力稍后再注入。
export const createGroupRuntimeScaffold = <
  TRenderable,
  TVisibleContext,
  TVisibleResult extends TRenderable[] | HTMLElement,
  TPreviousResult extends TRenderable[] | HTMLElement | null,
>(options: {
  resolveKeys(
    rendered: readonly TRenderable[],
    explicitKeys?: readonly PropertyKey[]
  ): readonly PropertyKey[];
  resolveRenderedEntries?(entries: readonly TRenderable[]): TRenderable[];
}): GroupScaffoldRuntime<
  TRenderable,
  TVisibleContext,
  TVisibleResult,
  TPreviousResult
> => {
  const { resolveKeys, resolveRenderedEntries = (entries) => [...entries] } =
    options;

  const runtime: GroupScaffoldRuntime<
    TRenderable,
    TVisibleContext,
    TVisibleResult,
    TPreviousResult
  > = {
    // 先铺设一套占位实现，保证 runtime 在绑定前也具备完整 shape。
    ...createPlaceholderKeys<TRenderable>(),
    ...createPlaceholderCommit<
      TRenderable,
      TVisibleContext,
      TVisibleResult,
      TPreviousResult
    >(),
    resolveKeys,
    commit(
      this: GroupScaffoldRuntime<
        TRenderable,
        TVisibleContext,
        TVisibleResult,
        TPreviousResult
      >,
      { keys, rendered }: GroupCommitInput<TRenderable>
    ) {
      // commit 的真实分支选择交给 commit intent 解析器，这里只负责整理输入。
      return commitByIntent({
        runtime: this,
        input: {
          keys,
          rendered,
        },
      });
    },
    commitVisible(
      this: GroupScaffoldRuntime<
        TRenderable,
        TVisibleContext,
        TVisibleResult,
        TPreviousResult
      >,
      { keys, rendered }: GroupCommitInput<TRenderable>
    ) {
      // visible commit 统一先拿 previous，再交给宿主提供的 context 构造器。
      const previous = this.resolvePrevious(keys);
      return this.commitVisibleContext(
        this.createContext({
          keys,
          rendered,
          previous,
        })
      );
    },
    renderEntries(renderEntries: () => readonly TRenderable[]) {
      // 不同 host 允许在这里对渲染结果做一次结构重整，例如拍平成快照数组。
      return resolveRenderedEntries(renderEntries());
    },
    createContext() {
      throw new Error(
        'Group runtime scaffold requires bindGroupHostRuntime() to provide createContext().'
      );
    },
  };

  return runtime;
};

// 统一把 stateKey、发布器、visible commit 流程与 previous commit 绑定到 runtime。
// 绑定顺序本身也有语义：先让 runtime 拿到状态键与发布器，再串起 visible/previous 提交流程。
export const bindGroupHostRuntime = <
  TRenderable,
  TVisibleContext,
  TVisibleResult extends TRenderable[] | HTMLElement,
  TPreviousResult extends TRenderable[] | HTMLElement | null,
>(options: {
  stateKey: string;
  runtime: GroupScaffoldRuntime<
    TRenderable,
    TVisibleContext,
    TVisibleResult,
    TPreviousResult
  > & {
    createContext(options: {
      keys: readonly PropertyKey[];
      rendered: readonly TRenderable[];
      previous: TransitionGroupState<TRenderable> | undefined;
    }): TVisibleContext;
  };
  publishState(
    input: GroupCommitPublishInput<TRenderable>
  ): TransitionGroupState<TRenderable>;
  dispatchVisibleCommitPhases(context: TVisibleContext): void;
  prepareVisibleCommit?(context: TVisibleContext): void;
  commitInitial?(
    input: GroupCommitInput<TRenderable>
  ): TRenderable[] | HTMLElement;
}): void => {
  const {
    stateKey,
    runtime,
    publishState,
    dispatchVisibleCommitPhases,
    prepareVisibleCommit,
    commitInitial,
  } = options;

  bindStateKeyRuntime({
    stateKey,
    runtime,
  });
  // previous commit 依赖 publishState，因此先把“如何发布 previous state”接上。
  bindPrevCommitStateRuntime({
    runtime: runtime as unknown as BasePrevApplier<
      GroupPrevCommitContext<TRenderable>,
      GroupPrevCommitResult<TRenderable>,
      TPreviousResult
    >,
    publishState,
  });
  bindCommitStateRuntime({
    runtime: runtime as unknown as {
      publishVisibleCommitState?(context: {
        publishStateInput: GroupCommitPublishInput<TRenderable>;
      }): GroupCommitResult<TRenderable>;
    },
    publishState,
  });
  bindCommitFlowRuntime({
    runtime,
    createContext: ({ keys, rendered, previous }) =>
      runtime.createContext({
        keys,
        rendered,
        previous,
      }),
    dispatchVisibleCommitPhases,
    prepareVisibleCommit,
    commitInitial,
  });
  bindPrevCommitRuntime({
    // 最后补全 previous commit 的对外入口，让 runtime 成为一份可直接调用的完整实现。
    stateKey,
    runtime: runtime as unknown as BasePrevApplier<
      GroupPrevCommitContext<TRenderable>,
      GroupPrevCommitResult<TRenderable>,
      TPreviousResult
    > & {
      commitHidden?(): TPreviousResult | null;
      commitPreviousContext(
        context: GroupPrevCommitContext<TRenderable>
      ): TPreviousResult;
    },
  });
};
