/**
 * TSX 绑定语法预处理器。
 *
 * TypeScript 自带的 TSX 解析器只认识标准 JSX attribute 名，无法原样吞下
 * `model:value.trim`、`click.stop.prevent` 这类带有框架扩展语义的绑定 token。
 * 因此在真正交给 TS 建 AST 之前，这里会先做一次“最小可逆”的源码级预处理。
 *
 * 设计原则有三条：
 * 1. 只处理 JSX 起始标签中的 attribute 名，不改文本节点、表达式内容与执行语义；
 * 2. 尽量保持源码长度和相对位置稳定，减少后续错误定位与 sourcemap 扰动；
 * 3. 保留足够线索，使后续绑定分析仍能恢复出原始的扩展绑定名和修饰符信息。
 *
 * 同一个模块里还会额外做一件事：在“标准 TSX 模式”下扫描并拦截已经废弃的旧式
 * 指令写法，优先给出框架级迁移提示，而不是让用户直接面对 TS 原生语法报错。
 */
import { escapeBindingNameForTsxParser } from '../analysis/binding';
import { DOM_EVENT_NAMES } from '../analysis/binding';

// 形如 `click.stop.prevent` 的 token 会被视为旧版扩展事件绑定语法。
const looksLikeLegacyEventBindingToken = (token: string): boolean => {
  return /^[a-z][a-z0-9:-]*(\.[a-z0-9:-]+)+$/.test(token);
};

const isIdentifierStart = (char: string): boolean => {
  return /[A-Za-z_:]/.test(char);
};

const isIdentifierPart = (char: string): boolean => {
  return /[A-Za-z0-9_:\-\.]/.test(char);
};

// 第一阶段只在“单个 JSX 起始标签”内工作，把可逆转义限制在 attribute 名这一层。
// 对单个 JSX 起始标签做扫描与转义，其余源码保持原样，减少对位置信息的扰动。
const normalizeJsxOpeningTag = (source: string): string => {
  let result = '';
  let index = 0;
  let braceDepth = 0;
  let quote: '"' | "'" | null = null;
  let tagNameConsumed = false;

  while (index < source.length) {
    const char = source[index];

    if (quote) {
      result += char;

      if (char === quote && source[index - 1] !== '\\') {
        quote = null;
      }

      index += 1;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      result += char;
      index += 1;
      continue;
    }

    if (char === '{') {
      braceDepth += 1;
      result += char;
      index += 1;
      continue;
    }

    if (char === '}') {
      braceDepth = Math.max(0, braceDepth - 1);
      result += char;
      index += 1;
      continue;
    }

    if (braceDepth > 0) {
      // `{ ... }` 内部可能出现任意 JS/TS 语法，交给 TS 原生解析，不在这里做 token 判断。
      result += char;
      index += 1;
      continue;
    }

    if (!tagNameConsumed) {
      // 起始标签的第一个标识符是标签名，不能被误判为需要转义的属性名。
      if (char === '<' || char === '/' || /\s/.test(char)) {
        result += char;
        index += 1;
        continue;
      }

      if (isIdentifierStart(char)) {
        let cursor = index + 1;

        while (cursor < source.length && isIdentifierPart(source[cursor])) {
          cursor += 1;
        }

        result += source.slice(index, cursor);
        tagNameConsumed = true;
        index = cursor;
        continue;
      }
    }

    if (isIdentifierStart(char)) {
      let cursor = index + 1;

      while (cursor < source.length && /[A-Za-z0-9_:\-]/.test(source[cursor])) {
        cursor += 1;
      }

      // 修饰符后缀（`.`）在这里一并纳入 token，避免 `onClick.stop` 被截成 `onClick` + `stop`。
      const baseToken = source.slice(index, cursor);
      // 只处理 React 风格事件名，`model:` / `bind:` 等指令名本身允许点号后缀，不能牵连。
      const isReactStyleEvent = /^on[A-Z]/.test(baseToken);
      // 修饰符后缀（`.`）在这里一并纳入 token，避免 `onClick.stop` 被截成 `onClick` + `stop`。
      if (isReactStyleEvent && source[cursor] === '.') {
        let modifierCursor = cursor;

        while (
          modifierCursor < source.length &&
          /[A-Za-z0-9_:\-.]/.test(source[modifierCursor])
        ) {
          modifierCursor += 1;
        }

        // HTML event 属性名必须是小写，这里拆成 `onclick__LANIA_DOT__stop` 交给解析器还原。
        result += escapeBindingNameForTsxParser(
          `${baseToken.slice(0, 2)}${baseToken.slice(2)}${source.slice(cursor, modifierCursor)}`
        );
        index = modifierCursor;
        continue;
      }

      // 指令名允许 `model:value.trim` 这种点号后缀，整体纳入 token 后再统一转义。
      let tokenCursor = cursor;

      while (
        tokenCursor < source.length &&
        /[A-Za-z0-9_:\-.]/.test(source[tokenCursor])
      ) {
        tokenCursor += 1;
      }

      const token = source.slice(index, tokenCursor);
      let lookahead = tokenCursor;

      while (lookahead < source.length && /\s/.test(source[lookahead])) {
        lookahead += 1;
      }

      // 只有“看起来像属性名，且后面紧跟 =”时才转义，避免把普通标识符误处理。
      result +=
        lookahead < source.length &&
        source[lookahead] === '=' &&
        token.includes('.')
          ? escapeBindingNameForTsxParser(token)
          : baseToken;
      index = token.includes('.') ? tokenCursor : cursor;
      continue;
    }

    result += char;
    index += 1;
  }

  return result;
};

const LEGACY_DIRECTIVE_PREFIXES = [
  'bind:',
  'model:',
  'class:',
  'style:',
  'use:',
  'on:',
] as const;

// 标准 TSX 模式下，这里用于识别哪些 attribute token 仍属于旧式指令语法。
const isLegacyTsxBindingToken = (token: string): boolean => {
  if (token === 'if') {
    return true;
  }

  if (LEGACY_DIRECTIVE_PREFIXES.some((prefix) => token.startsWith(prefix))) {
    return true;
  }

  const [eventCandidate] = token.split('.');
  if (
    DOM_EVENT_NAMES.has(eventCandidate) ||
    looksLikeLegacyEventBindingToken(token)
  ) {
    return true;
  }

  return false;
};

// 第二阶段只负责“发现并解释旧语法”，不与真正的预处理逻辑交叉，方便分别维护。
// 识别到旧语法后尽量给出对应的新写法建议，降低迁移成本。
const getLegacyTsxBindingSuggestion = (token: string): string => {
  // 提示文案按旧语法类别细分，尽量把用户直接引到新的推荐写法上。
  if (token === 'if') {
    return 'Use `<When when={...}>...</When>` in TSX.';
  }

  if (token.startsWith('bind:')) {
    return 'Use standard JSX props such as `value={...}` or `checked={...}`.';
  }

  if (token.startsWith('model:')) {
    return 'Use `value` / `checked` together with `onInput` / `onChange`.';
  }

  if (token.startsWith('class:')) {
    return 'Use `className={condition ? "name" : ""}` or compute the final class string.';
  }

  if (token.startsWith('style:')) {
    return 'Use `style={{ ... }}`.';
  }

  if (token.startsWith('use:')) {
    return 'TSX no longer supports directive syntax; move this to SFC template syntax or use standard JSX patterns.';
  }

  if (token.startsWith('on:')) {
    const eventName = token.slice(3);
    return `Use React-style handler props such as \`on${eventName.charAt(0).toUpperCase()}${eventName.slice(1)}={...}\`.`;
  }

  const [eventCandidate] = token.split('.');
  if (
    DOM_EVENT_NAMES.has(eventCandidate) ||
    looksLikeLegacyEventBindingToken(token)
  ) {
    return `Use React-style DOM events such as \`on${eventCandidate.charAt(0).toUpperCase()}${eventCandidate.slice(1)}={...}\`.`;
  }

  return 'Use standard JSX syntax instead.';
};

// 这是轻量级源码扫描器，只寻找“第一个旧语法属性名”，不尝试构建完整 JSX AST。
const findLegacyTsxBindingToken = (source: string): string | null => {
  let index = 0;
  let quote: '"' | "'" | null = null;

  while (index < source.length) {
    const char = source[index];

    if (quote) {
      if (char === quote && source[index - 1] !== '\\') {
        quote = null;
      }
      index += 1;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      index += 1;
      continue;
    }

    if (char === '<' && /[A-Za-z/]/.test(source[index + 1] ?? '')) {
      // 命中一个“可能是 JSX 标签”的片段后，才进入标签内扫描状态机。
      // 外层不尝试解析完整 JS/TS 语法，只保证不跨字符串边界误判。
      let cursor = index + 1;
      let tagQuote: '"' | "'" | null = null;
      let tagBraceDepth = 0;
      let tagNameConsumed = false;

      while (cursor < source.length) {
        const tagChar = source[cursor];

        if (tagQuote) {
          if (tagChar === tagQuote && source[cursor - 1] !== '\\') {
            tagQuote = null;
          }
          cursor += 1;
          continue;
        }

        if (tagChar === '"' || tagChar === "'") {
          tagQuote = tagChar;
          cursor += 1;
          continue;
        }

        if (tagChar === '{') {
          tagBraceDepth += 1;
          cursor += 1;
          continue;
        }

        if (tagChar === '}') {
          tagBraceDepth = Math.max(0, tagBraceDepth - 1);
          cursor += 1;
          continue;
        }

        if (tagBraceDepth === 0 && tagChar === '>') {
          break;
        }

        if (tagBraceDepth === 0 && !tagNameConsumed) {
          // 标签名本身允许带 `:` / `.` 等字符，但它不属于待检查的“属性 token”。
          // 因此这里先消费完整标签名，再开始识别后续属性。
          if (tagChar === '<' || tagChar === '/' || /\s/.test(tagChar)) {
            cursor += 1;
            continue;
          }

          if (isIdentifierStart(tagChar)) {
            cursor += 1;
            while (
              cursor < source.length &&
              isIdentifierPart(source[cursor]!)
            ) {
              cursor += 1;
            }
            tagNameConsumed = true;
            continue;
          }
        }

        if (tagBraceDepth === 0 && isIdentifierStart(tagChar)) {
          // 找到 attribute token 后只做一次轻量 lookahead，不在这里重建完整 JSX 语法树。
          const tokenStart = cursor;
          cursor += 1;
          while (cursor < source.length && isIdentifierPart(source[cursor]!)) {
            cursor += 1;
          }

          const token = source.slice(tokenStart, cursor);
          let lookahead = cursor;
          while (lookahead < source.length && /\s/.test(source[lookahead]!)) {
            lookahead += 1;
          }

          if (
            lookahead < source.length &&
            source[lookahead] === '=' &&
            isLegacyTsxBindingToken(token)
          ) {
            return token;
          }

          continue;
        }

        cursor += 1;
      }
    }

    index += 1;
  }

  return null;
};

export const assertNoLegacyTsxDirectiveSyntax = (
  fileName: string,
  source: string
): void => {
  const legacyToken = findLegacyTsxBindingToken(source);

  if (!legacyToken) {
    return;
  }

  // 标准 TSX 模式下直接报告第一个旧语法 token，便于用户快速定位与迁移。
  throw new Error(
    [
      `Legacy TSX directive syntax "${legacyToken}" is not supported in standard TSX mode for ${fileName}.`,
      getLegacyTsxBindingSuggestion(legacyToken),
      'Directive syntax remains available in SFC templates.',
    ].join(' ')
  );
};

/** 扫描源码中的 JSX 起始标签，并对扩展属性名做最小预处理。 */
export const preprocessTsxBindingSyntax = (
  _fileName: string,
  source: string
): string => {
  // 预处理按整份源码顺序扫描，但真正的改写边界始终收缩在单个标签片段内部。
  // 这里按标签片段做最小化改写，尽量保持其余源码位置稳定，便于后续错误定位。
  let result = '';
  let index = 0;
  let quote: '"' | "'" | null = null;

  while (index < source.length) {
    const char = source[index];

    if (quote) {
      result += char;

      if (char === quote && source[index - 1] !== '\\') {
        quote = null;
      }

      index += 1;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      result += char;
      index += 1;
      continue;
    }

    if (char === '{') {
      // 外层源码扫描阶段不追踪表达式嵌套，只原样透传，真正的 `{}` 配对在标签扫描里处理。
      result += char;
      index += 1;
      continue;
    }

    if (char === '}') {
      result += char;
      index += 1;
      continue;
    }

    if (char === '<' && /[A-Za-z/]/.test(source[index + 1] ?? '')) {
      // 命中一个可能的 JSX 起始标签后，只截取到配对的 `>` 做局部重写。
      // 这里不会深入处理嵌套标签，只负责拿到当前 opening tag 的原始片段。
      let cursor = index + 1;
      let tagQuote: '"' | "'" | null = null;
      let tagBraceDepth = 0;

      while (cursor < source.length) {
        const tagChar = source[cursor];

        if (tagQuote) {
          if (tagChar === tagQuote && source[cursor - 1] !== '\\') {
            tagQuote = null;
          }

          cursor += 1;
          continue;
        }

        if (tagChar === '"' || tagChar === "'") {
          tagQuote = tagChar;
          cursor += 1;
          continue;
        }

        if (tagChar === '{') {
          tagBraceDepth += 1;
          cursor += 1;
          continue;
        }

        if (tagChar === '}') {
          tagBraceDepth = Math.max(0, tagBraceDepth - 1);
          cursor += 1;
          continue;
        }

        if (tagBraceDepth === 0 && tagChar === '>') {
          const tagSource = source.slice(index, cursor + 1);
          // 只重写当前标签片段，其余源码保持原样，减少对定位信息的影响。
          result += normalizeJsxOpeningTag(tagSource);
          index = cursor + 1;
          break;
        }

        cursor += 1;
      }

      if (index === cursor + 1) {
        continue;
      }
    }

    result += char;
    index += 1;
  }

  return result;
};
