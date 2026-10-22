import {
  createSignal,
  createMemo,
} from './packages/runtime/src/reactivity/signal.ts';
import { watch } from './packages/runtime/src/reactivity/signal.ts';
import { defaultScheduler } from './packages/runtime/src/reactivity/scheduler.ts';
const flush = () => defaultScheduler.flush?.();

const s = createSignal({ user: { name: 'Ada' } });
console.log('A. 同一对象读取引用相等:', s() === s());
console.log('B. peek 引用相等:', s.peek() === s.peek());

const m = createMemo(() => s().user.name);
console.log('C. memo:', m());
s.set({ user: { name: 'Grace' } });
flush();
console.log('D. memo after set:', m());

const w = [];
watch(s, (cur, prev) => w.push(`${prev?.user?.name}->${cur?.user?.name}`), {
  deep: true,
});
s.set({ user: { name: 'Grace' } });
flush();
s.set({ user: { name: 'Lin' } });
flush();
console.log('E. watch deep:', JSON.stringify(w));
