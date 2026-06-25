import { describe, expect, it } from 'vitest';

import {
  createCodeFrame,
  createSourceDiagnosticOptions,
  createSourceRange,
  getOffsetFromLineColumn,
  getSourcePosition,
  SourceDiagnosticError,
} from '@lania-v/compiler-core';
import { createLaniaTsxCompileError, LaniaTsxCompileError } from '@lania-v/compiler-tsx';

describe('compiler diagnostics', () => {
  it('shares source position, range and code-frame helpers through compiler-core', () => {
    const source = ['first line', 'second line', 'third line'].join('\n');
    const offset = source.indexOf('second');

    expect(getSourcePosition(source, offset)).toEqual({
      offset,
      line: 2,
      column: 1,
    });
    expect(getOffsetFromLineColumn(source, 2, 1)).toBe(offset);
    expect(createSourceRange(source, offset, offset + 6)).toEqual({
      start: {
        offset,
        line: 2,
        column: 1,
      },
      end: {
        offset: offset + 6,
        line: 2,
        column: 7,
      },
    });
    expect(createCodeFrame(source, offset)).toContain('2 | second line');
  });

  it('creates reusable source diagnostic options for specialized compile errors', () => {
    const source = ['alpha', 'beta', 'gamma'].join('\n');
    const offset = source.indexOf('beta');
    const diagnostic = createSourceDiagnosticOptions({
      fileName: '/virtual/example.tsx',
      source,
      message: 'broken expression',
      offset,
    });

    expect(diagnostic).toEqual({
      message: 'broken expression',
      fileName: '/virtual/example.tsx',
      line: 2,
      column: 1,
      frame: expect.stringContaining('2 | beta'),
      cause: undefined,
    });

    const genericError = new SourceDiagnosticError(diagnostic);
    expect(genericError.fileName).toBe('/virtual/example.tsx');
    expect(genericError.line).toBe(2);
    expect(genericError.column).toBe(1);
    expect(genericError.frame).toContain('2 | beta');
  });

  it('keeps specialized error classes on top of the shared diagnostics base', () => {
    const tsxError = createLaniaTsxCompileError(
      '/virtual/Example.lania.tsx',
      'function Example() {\n  return <div />;\n}',
      'broken tsx',
      0
    );

    expect(tsxError).toBeInstanceOf(SourceDiagnosticError);
    expect(tsxError).toBeInstanceOf(LaniaTsxCompileError);
    expect(tsxError.fileName).toBe('/virtual/Example.lania.tsx');
  });
});
