/**
 * `Virtual` 的行尺寸账本。
 *
 * 可变行高虚拟滚动的核心难点是「位置查询」：给定 scrollTop 求首个可见行，
 * 或给定行号求偏移。逐行累加是 O(n)，每次滚动都算一遍会把滚动变成 O(n²)。
 *
 * 这里用 Fenwick（树状数组）维护每行已知/估算尺寸，把「前缀和」与「修改单行」
 * 都压到 O(log n)，因此即使列表有十万行、每行高度都被测量过，滚动仍然平滑。
 *
 * 估算值是账本的一部分：未测量的行用估算值占位，这样总高度与偏移在测量前就可用，
 * 不会出现「先渲染再跳一下」；实测值到达后就地覆盖对应槽位。
 */
import type { VirtualSizeInput } from '../types';

const DEFAULT_ESTIMATE = 32;

/** 单项尺寸来源：固定值、逐项数组或估算器。 */
const readSizeInput = (
  input: VirtualSizeInput | undefined,
  index: number,
  fallback: number
): number => {
  if (typeof input === 'number') {
    return input > 0 ? input : fallback;
  }

  if (typeof input === 'function') {
    const next = input(index);
    return Number.isFinite(next) && next > 0 ? next : fallback;
  }

  if (Array.isArray(input)) {
    const next = input[index];
    return typeof next === 'number' && next > 0 ? next : fallback;
  }

  return fallback;
};

/** 输入是否是「固定值」，用于判定能否跳过测量与锚定。 */
export const isFixedSizeInput = (
  input: VirtualSizeInput | undefined
): input is number => typeof input === 'number' && input > 0;

export class VirtualSizeCache {
  #sizes: number[] = [];
  #tree: number[] = [];
  #measured: boolean[] = [];
  #treeValid = false;
  readonly #heightInput: VirtualSizeInput | undefined;
  readonly #widthInput: VirtualSizeInput | undefined;
  #heightFallback = DEFAULT_ESTIMATE;
  #widthFallback = DEFAULT_ESTIMATE;

  constructor(heightInput?: VirtualSizeInput, widthInput?: VirtualSizeInput) {
    this.#heightInput = heightInput;
    this.#widthInput = widthInput;
    // 固定值直接作为兜底，避免估算器返回非法值时退化成 0。
    if (typeof heightInput === 'number' && heightInput > 0) {
      this.#heightFallback = heightInput;
    }
    if (typeof widthInput === 'number' && widthInput > 0) {
      this.#widthFallback = widthInput;
    }
  }

  get length(): number {
    return this.#sizes.length;
  }

  /** 重置为 `count` 行；保留已测量数据，仅增删尾部。 */
  resize(count: number): void {
    if (count === this.#sizes.length) {
      return;
    }

    if (count < this.#sizes.length) {
      this.#sizes.length = count;
      this.#measured.length = count;
      this.#treeValid = false;
      return;
    }

    for (let index = this.#sizes.length; index < count; index += 1) {
      this.#sizes.push(this.#estimate(index));
      this.#measured.push(false);
    }

    this.#treeValid = false;
  }

  #estimate(index: number): number {
    return readSizeInput(this.#heightInput, index, this.#heightFallback);
  }

  estimateWidth(index: number): number {
    return readSizeInput(this.#widthInput, index, this.#widthFallback);
  }

  size(index: number): number {
    return this.#sizes[index] ?? this.#estimate(index);
  }

  isMeasured(index: number): boolean {
    return this.#measured[index] === true;
  }

  /**
   * 写入实测值。返回 delta，调用方可据此做滚动锚定补偿。
   * 尺寸未真正变化时返回 0，避免无谓的重排。
   */
  setSize(index: number, size: number): number {
    if (index < 0 || index >= this.#sizes.length) {
      return 0;
    }

    if (!Number.isFinite(size) || size <= 0) {
      return 0;
    }

    const previous = this.#sizes[index]!;

    // 亚像素抖动不值得触发一次重排，否则滚动时会持续抖动。
    if (Math.abs(previous - size) < 0.5 && this.isMeasured(index)) {
      return 0;
    }

    this.#sizes[index] = size;
    this.#measured[index] = true;
    this.#treeValid = false;
    return size - previous;
  }

  /** 遍历写入实测值，返回总 delta。 */
  applyMeasurements(entries: Iterable<readonly [number, number]>): number {
    let delta = 0;

    for (const [index, size] of entries) {
      delta += this.setSize(index, size);
    }

    return delta;
  }

  #ensureTree(): number[] {
    if (this.#treeValid) {
      return this.#tree;
    }

    const count = this.#sizes.length;
    const tree = new Array<number>(count + 1).fill(0);

    for (let index = 0; index < count; index += 1) {
      tree[index + 1] = this.#sizes[index]!;
    }

    for (let index = 1; index <= count; index += 1) {
      const parent = index + (index & -index);
      if (parent <= count) {
        tree[parent]! += tree[index]!;
      }
    }

    this.#tree = tree;
    this.#treeValid = true;
    return tree;
  }

  /** 前 `count` 行的总尺寸。 */
  prefix(count: number): number {
    const limit = Math.min(Math.max(count, 0), this.#sizes.length);

    if (limit === 0) {
      return 0;
    }

    const tree = this.#ensureTree();

    let sum = 0;
    let index = limit;

    while (index > 0) {
      sum += tree[index]!;
      index -= index & -index;
    }

    return sum;
  }

  /** 第 `index` 行的起始偏移。 */
  offset(index: number): number {
    return this.prefix(index);
  }

  get total(): number {
    return this.prefix(this.#sizes.length);
  }

  /**
   * 找到包含 `offset` 的行号。
   * 二分 + Fenwick 前向搜索，复杂度 O(log n)；越界时收敛到首/尾行。
   */
  indexAt(offset: number): number {
    const count = this.#sizes.length;

    if (count === 0) {
      return 0;
    }

    if (offset <= 0) {
      return 0;
    }

    const tree = this.#ensureTree();

    let remaining = offset;
    let position = 0;
    let step = 1;

    while (step * 2 <= count) {
      step *= 2;
    }

    for (; step > 0; step >>= 1) {
      const next = position + step;

      if (next <= count && tree[next]! <= remaining) {
        position = next;
        remaining -= tree[next]!;
      }
    }

    // `position` 是「前 position 行总高 <= offset」的最大值，即目标行号。
    return Math.min(position, count - 1);
  }

  /** 该行在滚动方向上的结束位置。 */
  endOf(index: number): number {
    return this.offset(index) + this.size(index);
  }
}
