/**
 * 提供测试环境下的运行时状态重置入口。
 *
 * 每次测试结束后可调用该函数清空 directive、keepalive、transition 等共享状态。
 */
import { __resetBoundaryStateForTests } from '../component/lifecycle/boundary-registry';
import { __resetTransitionGroupStateForTests } from '../component/transition/group-registry';
import { __resetTransitionStateForTests } from '../component/transition/registry';
import { clearDirectiveRegistry } from '../dom/directives';
import { __resetKeepAliveSlotStateForTests } from '../dom/slots';

// 统一重置所有共享注册表，避免跨用例污染。
export const resetRuntimeTestState = (): void => {
  clearDirectiveRegistry();
  __resetKeepAliveSlotStateForTests();
  __resetBoundaryStateForTests();
  __resetTransitionStateForTests();
  __resetTransitionGroupStateForTests();
};
