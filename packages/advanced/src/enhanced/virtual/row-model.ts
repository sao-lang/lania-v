/**
 * `Virtual` 的行模型。
 *
 * 虚拟滚动需要一个扁平、可按下标寻址的行序列。业务数据里往往还夹着分组头，
 * 如果每次滚动都重新展开一次「数据 -> 行」的映射，既浪费又容易让 key 抖动。
 *
 * 这里在数据或 `groupBy` 变化时一次性构建行序列：每个数据项对应一到两行
 * （可选的分组头 + 数据行），并记录「行号 -> 数据下标」的反查表，
 * 渲染时只需按行号取用。
 */
import type { VirtualProps } from '../types';

export interface VirtualRow {
  readonly kind: 'item' | 'header';
  /** 稳定的渲染 key。 */
  readonly key: string;
  /** 数据项在 `value` 中的下标。 */
  readonly itemIndex: number;
  /** 分组头的分组名；数据行为 undefined。 */
  readonly group?: string;
}

export interface VirtualRowModel {
  readonly rows: readonly VirtualRow[];
  /** 行号 -> 数据下标，供滚动定位把「数据下标」翻译成「行号」。 */
  readonly rowOfItem: readonly number[];
}

export const buildRowModel = (
  items: readonly unknown[],
  groupBy: VirtualProps['groupBy']
): VirtualRowModel => {
  const rows: VirtualRow[] = [];
  const rowOfItem: number[] = new Array<number>(items.length);
  let previousGroup: string | null | undefined;

  for (let index = 0; index < items.length; index += 1) {
    const group = groupBy ? normalizeGroup(groupBy(items[index], index)) : null;

    // 只有分组名变化时才插入头行，同组连续项共享一个 sticky 头。
    if (group !== null && group !== previousGroup) {
      rows.push({
        kind: 'header',
        key: `#header:${group}`,
        itemIndex: index,
        group,
      });
    }

    previousGroup = group;
    rowOfItem[index] = rows.length;
    rows.push({
      kind: 'item',
      key: `#item:${index}`,
      itemIndex: index,
    });
  }

  return { rows, rowOfItem };
};

const normalizeGroup = (value: unknown): string | null => {
  if (value == null || value === '') {
    return null;
  }

  return String(value);
};
