import ts from 'typescript';

/**
 * TypeScript 源码解析辅助。
 *
 * 优化分析、依赖抽取等阶段经常需要把一小段源码重新喂给 TS parser，
 * 这里集中处理脚本类型推断与 `SourceFile` 创建，避免各处重复拼装参数。
 */
const getScriptKind = (fileName: string): ts.ScriptKind => {
  if (fileName.endsWith('.tsx')) {
    return ts.ScriptKind.TSX;
  }

  if (fileName.endsWith('.jsx')) {
    return ts.ScriptKind.JSX;
  }

  return ts.ScriptKind.TS;
};

export const parseTypeScriptSource = (
  fileName: string,
  source: string
): ts.SourceFile => {
  // 统一开启父节点回填，便于后续分析阶段沿 AST 向上追溯上下文。
  return ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    getScriptKind(fileName)
  );
};
