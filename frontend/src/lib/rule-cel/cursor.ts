/** A position in a token list, with the small checks every parsing rule needs. */
import { celError, type CelErrorArgs, type CelErrorKey } from '@/lib/rule-cel/types';
import type { Token } from '@/lib/rule-cel/lexer';

export class Cursor {
  private index = 0;

  constructor(private readonly tokens: readonly Token[]) {}

  peek(ahead = 0): Token {
    return this.tokens[Math.min(this.index + ahead, this.tokens.length - 1)];
  }

  next(): Token {
    const token = this.peek();
    if (token.kind !== 'eof') this.index += 1;
    return token;
  }

  isPunct(text: string, ahead = 0): boolean {
    const token = this.peek(ahead);
    return token.kind === 'punct' && token.text === text;
  }

  isIdent(text: string, ahead = 0): boolean {
    const token = this.peek(ahead);
    return token.kind === 'ident' && token.text === text;
  }

  /** Consumes the punctuation or reports which symbol was expected there. */
  expectPunct(text: string): Token {
    if (!this.isPunct(text)) throw this.fail('expectedSymbol', { symbol: text });
    return this.next();
  }

  /** An error at the current token. */
  fail(key: CelErrorKey, args: CelErrorArgs = {}) {
    const token = this.peek();
    return celError(token.start, key, args, token.end - token.start);
  }
}

/** An error covering one token. */
export function failAt(token: Token, key: CelErrorKey, args: CelErrorArgs = {}) {
  return celError(token.start, key, args, token.end - token.start);
}
