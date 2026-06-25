/**
 * 根据 hostMode 选择 TransitionGroup 的具体运行时实现。
 *
 * `dom-host` 模式负责托管真实容器，其余模式走 snapshot runtime。
 */
import type { TransitionDispatchHook } from '../../host';
import type { GroupHookContext, LeaveFinalizeHost } from '../../registry';
import { bootstrapSnapshotRuntime } from './snapshot-runtime';
import { bootstrapDomHostRuntime } from './dom-host-runtime';
import type { TransitionGroupHostMode } from './host-mode';
import type {
  GroupPhaseEnabled,
  GroupPhaseHooks,
  TransitionGroupRuntime,
} from '../types';

// 运行时选择只发生在启动阶段，后续 commit 都复用返回的具体 runtime。
export const bootstrapGroupRuntime = <TRenderable>(options: {
  hostMode: TransitionGroupHostMode;
  stateKey: string;
  transitionTag?: string;
  name?: string;
  leaveHook?: TransitionDispatchHook<GroupHookContext>;
  leaveEnabled: boolean;
  phaseHooks?: GroupPhaseHooks;
  phaseEnabled?: GroupPhaseEnabled;
  host?: LeaveFinalizeHost;
  getElements: (snapshot: TRenderable) => readonly Element[];
}): TransitionGroupRuntime<TRenderable> => {
  const {
    hostMode,
    stateKey,
    transitionTag,
    name,
    leaveHook,
    leaveEnabled,
    phaseHooks,
    phaseEnabled,
    host,
    getElements,
  } = options;

  return hostMode === 'dom-host'
    ? bootstrapDomHostRuntime({
        stateKey,
        transitionTag: transitionTag ?? 'div',
        name,
        hook: leaveHook,
        phaseHooks,
        phaseEnabled,
      })
    : bootstrapSnapshotRuntime({
        stateKey,
        transitionTag,
        name,
        phaseHooks,
        phaseEnabled,
        leaveHook,
        leaveEnabled,
        host,
        getElements,
      });
};
