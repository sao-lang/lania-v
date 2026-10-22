/**
 * TSX 编译阶段错误封装工具。
 *
 * 这个模块负责把不同来源的异常统一压平为同一种可展示错误模型：
 * 1. 解析阶段抛出的语法或结构错误；
 * 2. compiler-core 流水线抛出的 lowering / codegen 错误；
 * 3. 外部错误消息里携带的 `file:line:column` 位置信息。
 *
 * 目标是让 IDE、测试和上层插件总能拿到带源码坐标、代码框和统一命名的诊断对象，
 * 而不是原始散乱异常。
 */
import {
  createSourceDiagnosticOptions,
  getOffsetFromLineColumn,
  SourceDiagnosticError,
} from '@lania-v/compiler-core';

// 优先匹配独立一行的 `file:line:column` 位置描述，兼容常见编译器错误格式。
const LOCATION_PATTERN = /^(.*):(\d+):(\d+)$/;

export class LaniaTsxCompileError extends SourceDiagnosticError {
  constructor(options: {
    message: string;
    fileName: string;
    line: number;
    column: number;
    frame: string;
    cause?: unknown;
  }) {
    super(options);
    this.name = 'LaniaTsxCompileError';
  }
}

const extractMessageLocation = (
  fileName: string,
  message: string
): { line: number; column: number } | null => {
  const lines = message.split('\n');

  for (const line of lines) {
    // 优先匹配独立一行的 `file:line:column` 格式。
    const match = line.trim().match(LOCATION_PATTERN);
    if (!match) {
      continue;
    }

    const [, matchedFileName, matchedLine, matchedColumn] = match;
    if (matchedFileName !== fileName) {
      continue;
    }

    return {
      line: Number(matchedLine),
      column: Number(matchedColumn),
    };
  }

  // 某些上游错误会把位置信息嵌入长消息中，这里再兜底扫描一次。
  const indexedLocationPattern = new RegExp(
    `${fileName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:([0-9]+):([0-9]+)`
  );
  const indexedLocation = message.match(indexedLocationPattern);
  if (!indexedLocation) {
    return null;
  }

  return {
    line: Number(indexedLocation[1]),
    column: Number(indexedLocation[2]),
  };
};

export const createLaniaTsxCompileError = (
  fileName: string,
  source: string,
  message: string,
  offset = 0,
  cause?: unknown
): LaniaTsxCompileError => {
  return new LaniaTsxCompileError(
    // 统一复用共享诊断选项构造逻辑，保持所有编译入口的错误外观一致。
    createSourceDiagnosticOptions({
      fileName,
      source,
      message,
      offset,
      cause,
    })
  );
};

export const wrapLaniaTsxCompileError = (
  fileName: string,
  source: string,
  error: unknown
): LaniaTsxCompileError => {
  if (error instanceof LaniaTsxCompileError) {
    return error;
  }

  // 统一把任意异常折叠成带源码位置的编译错误，便于 IDE、测试与上游插件复用。
  const message =
    error instanceof Error
      ? error.message
      : 'Unknown .lania.tsx compile error.';
  const location = extractMessageLocation(fileName, message);
  // 若消息中带了行列号，就回算成字符偏移，便于统一生成代码框。
  const offset = location
    ? getOffsetFromLineColumn(source, location.line, location.column)
    : 0;

  return createLaniaTsxCompileError(
    fileName,
    source,
    `.lania.tsx compile failed: ${message}`,
    offset,
    error
  );
};
