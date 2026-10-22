/**
 * 源码位置信息与诊断辅助。
 *
 * 这个模块负责把“基于 offset 的内部定位信息”转换成更适合报错展示的数据结构，
 * 供解析、转换、优化等阶段统一复用。它主要解决三类问题：
 * - 把字符偏移量换算成行列号，便于直接给用户定位源码位置；
 * - 生成包含上下文与插入符的 code frame，提升错误可读性；
 * - 把这些信息封装成统一的诊断对象和异常类型，避免各阶段重复拼装报错数据。
 *
 * 这里的设计重点是“输入简单、输出稳定”：
 * 上游只要提供原始源码和 offset，就能得到一致的定位结果，
 * 这样编译管线中的不同模块无需各自实现一套行列号换算逻辑。
 */
export interface SourcePosition {
  offset: number;
  line: number;
  column: number;
}

export interface SourceRange {
  start: SourcePosition;
  end: SourcePosition;
}

export interface SourceDiagnosticErrorOptions {
  message: string;
  fileName: string;
  line: number;
  column: number;
  frame: string;
  cause?: unknown;
}

export class SourceDiagnosticError extends Error {
  // 文件名、行列号和代码片段直接挂在错误对象上，方便上游统一格式化输出。
  fileName: string;
  line: number;
  column: number;
  frame: string;
  cause?: unknown;

  constructor(options: SourceDiagnosticErrorOptions) {
    super(options.message);
    this.name = 'SourceDiagnosticError';
    this.fileName = options.fileName;
    this.line = options.line;
    this.column = options.column;
    this.frame = options.frame;
    this.cause = options.cause;
  }
}

export const getSourcePosition = (
  source: string,
  offset: number
): SourcePosition => {
  // 先把 offset 钳制到源码边界内，避免越界时得到负数或超长切片。
  const safeOffset = Math.max(0, Math.min(offset, source.length));
  // 只截取当前位置之前的前缀，再用换行拆分即可得到当前位置所在的行列。
  const prefix = source.slice(0, safeOffset);
  const lines = prefix.split('\n');

  return {
    offset: safeOffset,
    line: lines.length,
    column: (lines.at(-1)?.length ?? 0) + 1,
  };
};

export const createSourceRange = (
  source: string,
  startOffset: number,
  endOffset: number
): SourceRange => {
  // range 的两端都统一走 position 计算，保证 start/end 的换算规则完全一致。
  return {
    start: getSourcePosition(source, startOffset),
    end: getSourcePosition(source, endOffset),
  };
};

export const getOffsetFromLineColumn = (
  source: string,
  line: number,
  column: number
): number => {
  const lines = source.split('\n');
  if (line <= 1) {
    // 第一行不需要累计前缀长度，列号减一后就是 offset。
    return Math.max(0, column - 1);
  }

  let offset = 0;
  // 逐行累加前置长度，把目标行之前的换行符也一起计入。
  for (let index = 0; index < Math.min(line - 1, lines.length); index += 1) {
    offset += (lines[index]?.length ?? 0) + 1;
  }

  // 最终结果再次钳制到源码范围，避免外部传入过大的列号。
  return Math.max(0, Math.min(offset + column - 1, source.length));
};

export const createCodeFrame = (source: string, offset: number): string => {
  const position = getSourcePosition(source, offset);
  const lines = source.split('\n');
  const lineIndex = Math.max(0, position.line - 1);
  // 目前只展示目标行前后一行，既能提供上下文，又避免 frame 过长。
  const startLine = Math.max(0, lineIndex - 1);
  const endLine = Math.min(lines.length - 1, lineIndex + 1);

  return lines
    .slice(startLine, endLine + 1)
    .map((line, index) => {
      const actualLine = startLine + index + 1;
      // gutter 固定宽度，保证多行 frame 在视觉上对齐。
      const gutter = `${actualLine}`.padStart(4, ' ');
      const marker =
        actualLine === position.line
          ? // 插入符只打在目标行，对齐列号后直观标出出错位置。
            `\n     | ${' '.repeat(Math.max(0, position.column - 1))}^`
          : '';

      return `${gutter} | ${line}${marker}`;
    })
    .join('\n');
};

export const createSourceDiagnosticOptions = (options: {
  fileName: string;
  source: string;
  message: string;
  offset: number;
  cause?: unknown;
}): SourceDiagnosticErrorOptions => {
  // 对外暴露一个“从 source + offset 直接组装诊断”的入口，减少调用方样板代码。
  const position = getSourcePosition(options.source, options.offset);

  return {
    message: options.message,
    fileName: options.fileName,
    line: position.line,
    column: position.column,
    frame: createCodeFrame(options.source, options.offset),
    cause: options.cause,
  };
};
