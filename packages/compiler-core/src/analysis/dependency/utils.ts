import ts from 'typescript';

/**
 * 依赖分析辅助工具。
 *
 * 这些函数服务于 `analysis/dependency/*` 下的多处分析逻辑，主要解决三类重复问题：
 * 1. 用 `Record<string, Set<...>>` 这种结构暂存依赖、路径和索引集合；
 * 2. 在分析结束后把这些 `Set` 结构稳定地归一化为可输出、可比较的数组结果；
 * 3. 处理标识符清洗、赋值运算符识别、对象字面量属性名读取等底层 AST 细节。
 *
 * 它们本身不负责“判定依赖关系”，而是为上层分析器提供稳定的数据容器和小型语法工具。
 */

// 常用的记录表工厂：初始化时统一返回空 record，避免调用方重复书写样板代码。
export const createRecordSet = (): Record<string, Set<string>> => ({});
export const createNumberSetRecord = (): Record<string, Set<number>> => ({});
export const createPathRecord = (): Record<string, Set<string>> => ({});

// 把任意文本清洗成可安全拼进变量名/缓存 key 的 token。
export const sanitizeIdentifierToken = (value: string): string => {
  const normalized = value
    .replace(/[^a-zA-Z0-9_$]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return normalized.length > 0 ? normalized : 'token';
};

// 给 `Record<string, Set<string>>` 追加值；不存在的 key 会在这里惰性创建。
export const pushRecordSetValue = (
  record: Record<string, Set<string>>,
  key: string,
  value: string
): void => {
  if (!record[key]) {
    record[key] = new Set<string>();
  }

  record[key].add(value);
};

// 与上面同理，只是 value 类型换成数字集合。
export const pushRecordNumberValue = (
  record: Record<string, Set<number>>,
  key: string,
  value: number
): void => {
  if (!record[key]) {
    record[key] = new Set<number>();
  }

  record[key].add(value);
};

// 路径值先序列化成 JSON 字符串再去重，避免数组对象本身无法直接按值比较的问题。
export const pushPathValue = (
  record: Record<string, Set<string>>,
  key: string,
  value: string[]
): void => {
  if (value.length === 0) {
    return;
  }

  if (!record[key]) {
    record[key] = new Set<string>();
  }

  record[key].add(JSON.stringify(value));
};

// 把 Set 结构稳定转换为排序后的数组，便于快照、调试和后续比较。
export const normalizeRecordSet = (
  record: Record<string, Set<string>>
): Record<string, string[]> => {
  return Object.fromEntries(
    Object.entries(record).map(([key, values]) => [key, [...values].sort()])
  );
};

// 数字集合在归一化时按数值大小排序，而不是按字符串字典序。
export const normalizeNumberRecordSet = (
  record: Record<string, Set<number>>
): Record<string, number[]> => {
  return Object.fromEntries(
    Object.entries(record).map(([key, values]) => [
      key,
      [...values].sort((a, b) => a - b),
    ])
  );
};

// 路径集合会先反序列化回数组，再按 `a.b.c` 形式做稳定排序。
export const normalizePathRecord = (
  record: Record<string, Set<string>>
): Record<string, string[][]> => {
  return Object.fromEntries(
    Object.entries(record).map(([key, values]) => [
      key,
      [...values]
        .map((value) => JSON.parse(value) as string[])
        .sort((left, right) => left.join('.').localeCompare(right.join('.'))),
    ])
  );
};

// 依赖分析里需要识别各种 `=` / `+=` / `??=` 等赋值运算符，这里统一走 TS 的 SyntaxKind 范围判断。
export const isAssignmentOperatorToken = (kind: ts.SyntaxKind): boolean => {
  return (
    kind >= ts.SyntaxKind.FirstAssignment &&
    kind <= ts.SyntaxKind.LastAssignment
  );
};

// 当前约定中，带连字符的标签名视为静态组件标签。
export const isStaticComponentTag = (tagName: string): boolean => {
  return tagName.includes('-');
};

// 只提取可以静态读出的对象字面量属性名；动态计算属性会返回 null，交给上层兜底处理。
export const getObjectLiteralPropertyName = (
  name: ts.PropertyName
): string | null => {
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNumericLiteral(name)
  ) {
    return name.text;
  }

  return null;
};
