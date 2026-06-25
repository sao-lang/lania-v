/**
 * 复用模板 slot 运行时使用的节点数组缓冲区。
 *
 * 通过对象池减少 keepalive/slot 在频繁挂载卸载时产生的短生命周期数组分配。
 */
const pooledNodeArrays: Node[][] = [];

// 获取缓冲区时会先清空旧内容，确保调用方拿到干净数组。
export const acquireSlotNodeBuffer = (): Node[] => {
  const buffer = pooledNodeArrays.pop();

  if (!buffer) {
    return [];
  }

  buffer.length = 0;
  return buffer;
};

// 归还时只回收到池中，不保留任何旧节点引用。
export const releaseSlotNodeBuffer = (buffer: Node[]): void => {
  buffer.length = 0;
  pooledNodeArrays.push(buffer);
};

export const getSlotPoolStats = (): { availableNodeBuffers: number } => {
  return {
    availableNodeBuffers: pooledNodeArrays.length,
  };
};

export const clearSlotPool = (): void => {
  pooledNodeArrays.length = 0;
};
