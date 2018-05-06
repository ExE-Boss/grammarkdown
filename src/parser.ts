﻿/*!
 *  Copyright 2015 Ron Buckton (rbuckton@chronicles.org)
 *
 *  Licensed under the Apache License, Version 2.0 (the "License");
 *  you may not use this file except in compliance with the License.
 *  You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 *  Unless required by applicable law or agreed to in writing, software
 *  distributed under the License is distributed on an "AS IS" BASIS,
 *  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *  See the License for the specific language governing permissions and
 *  limitations under the License.
 */
import { Range, TextRange, last, stableSort } from "./core";
import { Diagnostics, DiagnosticMessages, NullDiagnosticMessages, LineMap, formatList } from "./diagnostics";
import { SyntaxKind, tokenToString, ProductionSeperatorKind, ArgumentOperatorKind, LookaheadOperatorKind, ParameterOperatorKind, TokenKind } from "./tokens";
import { Scanner } from "./scanner";
import { CancellationToken } from "prex";
import {
    Node,
    Token,
    StringLiteral,
    SourceFile,
    UnicodeCharacterLiteral,
    Prose,
    Identifier,
    Parameter,
    ParameterList,
    OneOfList,
    Terminal,
    SymbolSet,
    Assertion,
    InvalidAssertion,
    EmptyAssertion,
    LookaheadAssertion,
    NoSymbolHereAssertion,
    LexicalGoalAssertion,
    ParameterValueAssertion,
    ProseAssertion,
    ProseFragmentLiteral,
    Argument,
    ArgumentList,
    Nonterminal,
    OneOfSymbol,
    LexicalSymbol,
    PlaceholderSymbol,
    InvalidSymbol,
    ButNotSymbol,
    UnicodeCharacterRange,
    SymbolSpan,
    LinkReference,
    RightHandSide,
    RightHandSideList,
    Production,
    Import,
    Define,
    MetaElement,
    SourceElement,
    PrimarySymbol,
    HtmlTrivia
} from "./nodes";

const enum ParsingContext {
    SourceElements,
    Parameters,
    BracketedParameters,
    Arguments,
    BracketedArguments,
    RightHandSideListIndented,
    SymbolSet,
    OneOfList,
    OneOfListIndented,
    OneOfSymbolList,
    NoSymbolHere
}

interface ListTypes {
    [ParsingContext.SourceElements]: SourceElement;
    [ParsingContext.Parameters]: Parameter;
    [ParsingContext.BracketedParameters]: Parameter;
    [ParsingContext.Arguments]: Argument;
    [ParsingContext.BracketedArguments]: Argument;
    [ParsingContext.RightHandSideListIndented]: RightHandSide;
    [ParsingContext.SymbolSet]: SymbolSpan;
    [ParsingContext.OneOfList]: Terminal;
    [ParsingContext.OneOfListIndented]: Terminal;
    [ParsingContext.OneOfSymbolList]: LexicalSymbol;
    [ParsingContext.NoSymbolHere]: PrimarySymbol;
}

enum SkipWhitespace {
    None = 0,
    LineTerminator = 0x1,
    Indentation = 0x2,
    All = LineTerminator | Indentation,
}

export interface TextChange {
    range: Range;
    text: string;
}

export namespace TextChange {
    export function create(text: string, range: Range) {
        return { text, range };
    }

    export function clone(change: TextChange) {
        return create(change.text, Range.clone(change.range));
    }

    export function isUnchanged(change: TextChange) {
        return change.text.length === 0
            && Range.isCollapsed(change.range);
    }

    export function applyChange(originalText: string, change: TextChange) {
        if (isUnchanged(change)) {
            return originalText;
        }

        const lineMap = new LineMap(originalText);
        const pos = lineMap.offsetAt(change.range.start);
        const end = lineMap.offsetAt(change.range.end);
        return originalText.substr(0, pos) + change.text + originalText.substr(end);
    }
}

export class Parser {
    private scanner!: Scanner;
    /* @internal */ token!: SyntaxKind;
    private imports!: string[];
    private diagnostics!: DiagnosticMessages;
    private parsingContext!: ParsingContext;
    private cancellationToken!: CancellationToken;
    private tags: Map<number, HtmlTrivia[]> | undefined;
    private tagsOffset!: number;

    // TODO(rbuckton): Incremental parser
    // public updateSourceFile(sourceFile: SourceFile, change: TextChange) {
    //     if (TextChange.isUnchanged(change)) {
    //         return sourceFile;
    //     }

    //     if (sourceFile.elements.length === 0) {
    //         return this.parseSourceFile(sourceFile.filename, change.text);
    //     }

    //     const navigator = new NodeNavigator(sourceFile);
    //     navigator.moveToPosition(change.range.start);
    //     navigator.moveToSourceElement();
    //     const startPos = navigator.getNode().pos;
    //     const startOffset = navigator.getOffset();
    //     navigator.moveToPosition(change.range.end);
    //     navigator.moveToSourceElement();
    //     const endPos = navigator.getNode().end;
    //     const endOffset = navigator.getOffset();

    //     // 1) replace the text from sourceFile.text with the specified changes
    //     // 2) create a new SourceFile, copying nodes from the original source file
    //     // up to startOffset
    //     // 3) parse the new text fragment, adding nodes to the new SourceFile
    //     // 4) clone nodes from the old source file to the new source file
    //     // with new positions
    // }

    public parseSourceFile(filename: string, text: string, cancellationToken = CancellationToken.none): SourceFile {
        cancellationToken.throwIfCancellationRequested();
        const savedImports = this.imports;
        const savedDiagnostics = this.diagnostics;
        const savedCancellationToken = this.cancellationToken;
        const savedScanner = this.scanner;
        const savedParsingContext = this.parsingContext;
        const savedTags = this.tags;
        const savedTagsOffset = this.tagsOffset;
        try {
            return this.parse(filename, text, /*previousSourceFile*/ undefined, /*changeRange*/ undefined, cancellationToken);
        }
        finally {
            this.imports = savedImports;
            this.diagnostics = savedDiagnostics;
            this.cancellationToken = savedCancellationToken;
            this.scanner = savedScanner;
            this.parsingContext = savedParsingContext;
            this.tags = savedTags;
            this.tagsOffset = savedTagsOffset;
        }
    }

    private parse(filename: string, text: string, previousSourceFile: SourceFile | undefined, changeRange: TextRange | undefined, cancellationToken: CancellationToken) {
        const elements: SourceElement[] = [];
        const sourceFile = new SourceFile(filename, text, elements);
        this.imports = [];
        this.diagnostics = new DiagnosticMessages();
        this.diagnostics.setSourceFile(sourceFile);
        this.cancellationToken = cancellationToken;
        this.parsingContext = ParsingContext.SourceElements;
        this.tagsOffset = 0;
        this.scanner = new Scanner(filename, text, this.diagnostics, this.cancellationToken);

        this.nextToken();
        this.parseSourceElementList(elements);
        sourceFile.imports = this.imports;
        sourceFile.parseDiagnostics = this.diagnostics;
        return sourceFile;
    }

    private nextToken(): SyntaxKind {
        this.token = this.scanner.scan();
        const htmlTrivia = trimTrivia(this.scanner.getHtmlTrivia());
        if (htmlTrivia) {
            if (!this.tags) this.tags = new Map<number, HtmlTrivia[]>();
            this.tags.set(this.scanner.getStartPos(), htmlTrivia);
        }
        return this.token;
    }

    private lookahead<T>(callback: () => T): T {
        return this.speculate(callback, /*isLookahead*/ true);
    }

    private tryParse<T>(callback: () => T): T {
        return this.speculate(callback, /*isLookahead*/ false);
    }

    private speculate<T>(callback: () => T, isLookahead: boolean): T {
        const saveToken = this.token;
        const saveParsingContext = this.parsingContext;
        const saveDiagnostics = this.diagnostics;

        this.diagnostics = NullDiagnosticMessages.instance;
        const result = this.scanner.speculate(callback, isLookahead);

        this.diagnostics = saveDiagnostics;
        if (!result || isLookahead) {
            this.token = saveToken;
            this.parsingContext = saveParsingContext;
        }

        return result;
    }

    private isWhitespace(skip: SkipWhitespace = SkipWhitespace.All): boolean {
        switch (this.token) {
            case SyntaxKind.LineTerminatorToken:
                return !!(skip & SkipWhitespace.LineTerminator);

            case SyntaxKind.IndentToken:
            case SyntaxKind.DedentToken:
                return !!(skip & SkipWhitespace.Indentation);

            default:
                return false;
        }
    }

    private isEOF(): boolean {
        return this.token === SyntaxKind.EndOfFileToken;
    }

    private skipUntil(isRecoveryToken: (token: SyntaxKind) => boolean): void {
        while (!isRecoveryToken(this.token) && !this.isEOF()) {
            this.nextToken();
        }
    }

    private skipWhitespace(skip: SkipWhitespace = SkipWhitespace.All): void {
        while (this.isWhitespace(skip)) {
            this.nextToken();
        }
    }

    private readTokenValue(token: SyntaxKind): string | undefined {
        if (this.token === token) {
            const text = this.scanner.getTokenValue();
            this.nextToken();
            return text;
        }

        return undefined;
    }

    private readTokenText(token: SyntaxKind): string | undefined {
        if (this.token === token) {
            const text = this.scanner.getTokenText();
            this.nextToken();
            return text;
        }

        return undefined;
    }

    private finishNode<TNode extends Node>(node: TNode, fullStart: number): TNode {
        if (node) {
            node.pos = fullStart;
            node.end = this.scanner.getStartPos();
            if (this.tags) {
                attachHtmlTrivia(node, this.tags.get(node.pos), this.tags.get(node.end));
            }
            promoteHtmlTrivia(node, node.firstChild, node.lastChild);
        }
        return node;
    }

    private parseToken<TKind extends TokenKind>(token: TKind): Token<TKind> | undefined {
        if (this.token === token) {
            const fullStart = this.scanner.getStartPos();
            this.nextToken();
            return this.finishNode(new Token(token), fullStart);
        }

        return undefined;
    }

    private parseAnyToken<TKind extends TokenKind>(predicate: (token: SyntaxKind) => token is TKind): Token<TKind> | undefined {
        const token = this.token;
        if (predicate(token)) {
            const fullStart = this.scanner.getStartPos();
            this.nextToken();
            return this.finishNode(new Token(token), fullStart);
        }

        return undefined;
    }

    private parseOptional(token: SyntaxKind): boolean {
        if (this.token === token) {
            this.nextToken();
            return true;
        }
        else {
            return false;
        }
    }

    // private parseExpected(token: SyntaxKind): boolean {
    //     if (this.token === token) {
    //         this.nextToken();
    //         return true;
    //     }
    //     else {
    //         this.diagnostics.report(this.scanner.getTokenPos(), Diagnostics._0_expected, tokenToString(token));
    //         return false;
    //     }
    // }

    // private parseExpectedOrEndOfFile(token: SyntaxKind): boolean {
    //     if (this.isEOF()) {
    //         return true;
    //     }
    //     return this.parseExpected(token);
    // }

    // list parsing
    private shouldParseElement(): boolean {
        switch (this.parsingContext) {
            case ParsingContext.SourceElements:
                return this.isStartOfSourceElement();

            case ParsingContext.Parameters:
            case ParsingContext.BracketedParameters:
                return this.isStartOfParameter();

            case ParsingContext.Arguments:
            case ParsingContext.BracketedArguments:
                return this.isStartOfArgument();

            case ParsingContext.RightHandSideListIndented:
                return this.isStartOfRightHandSide();

            case ParsingContext.SymbolSet:
                return this.token === SyntaxKind.Terminal || this.token === SyntaxKind.Identifier || this.token === SyntaxKind.UnicodeCharacterLiteral;

            case ParsingContext.OneOfList:
            case ParsingContext.OneOfListIndented:
                return this.token === SyntaxKind.Terminal || this.token === SyntaxKind.UnicodeCharacterLiteral;

            case ParsingContext.OneOfSymbolList:
                return this.token === SyntaxKind.Terminal || this.token === SyntaxKind.Identifier || this.token === SyntaxKind.UnicodeCharacterLiteral;

            case ParsingContext.NoSymbolHere:
                return this.token === SyntaxKind.Terminal || this.token === SyntaxKind.Identifier || this.token === SyntaxKind.UnicodeCharacterLiteral;

            default:
                return false;
        }
    }

    private shouldSkipWhitespace(): SkipWhitespace {
        switch (this.parsingContext) {
            case ParsingContext.SourceElements:
                // whitespace in the SourceElements context has no meaning
                return SkipWhitespace.LineTerminator
                    | SkipWhitespace.Indentation;

            case ParsingContext.Parameters:
            case ParsingContext.BracketedParameters:
            case ParsingContext.Arguments:
            case ParsingContext.BracketedArguments:
            case ParsingContext.SymbolSet:
                // These elements are enclosed in parenthesis or braces, so whitespace has no meaning
                return SkipWhitespace.LineTerminator
                    | SkipWhitespace.Indentation;

            case ParsingContext.RightHandSideListIndented:
                // All whitespace is significant in a RHS list
                return SkipWhitespace.LineTerminator;

            case ParsingContext.OneOfList:
                // All whitespace is significant in a one-of list (non-indented)
                return SkipWhitespace.None;

            case ParsingContext.OneOfListIndented:
                // Only indentation is significatn in a one-of list (indented)
                return SkipWhitespace.LineTerminator;

            case ParsingContext.OneOfSymbolList:
                return SkipWhitespace.None;

            case ParsingContext.NoSymbolHere:
                return SkipWhitespace.None;

            default:
                // assume significant whitespace for new parsing contexts
                return SkipWhitespace.None;
        }
    }

    private shouldConsumeCloseToken(): boolean {
        switch (this.parsingContext) {
            case ParsingContext.Parameters:
            case ParsingContext.BracketedParameters:
            case ParsingContext.Arguments:
            case ParsingContext.BracketedArguments:
            case ParsingContext.SymbolSet:
            case ParsingContext.OneOfListIndented:
            case ParsingContext.RightHandSideListIndented:
            case ParsingContext.NoSymbolHere:
                return false;

            default:
                return true;
        }
    }

    private parseElement<TParsingContext extends ParsingContext>(listContext: TParsingContext): ListTypes[TParsingContext] | undefined {
        switch (listContext) {
            case ParsingContext.SourceElements:
                return this.parseSourceElement();

            case ParsingContext.Parameters:
            case ParsingContext.BracketedParameters:
                return this.parseParameter();

            case ParsingContext.Arguments:
            case ParsingContext.BracketedArguments:
                return this.parseArgument();

            case ParsingContext.RightHandSideListIndented:
                return this.parseRightHandSide();

            case ParsingContext.SymbolSet:
                return this.parseSymbolSpan();

            case ParsingContext.OneOfList:
            case ParsingContext.OneOfListIndented:
                return this.parseTerminal(/*allowOptional*/ false);

            case ParsingContext.OneOfSymbolList:
            case ParsingContext.NoSymbolHere:
                return this.parsePrimarySymbol(/*allowOptional*/ false);

            default:
                console.error(`Unexpected parsing context: ${this.parsingContext}`);
                return undefined;
        }
    }

    private recover(): void {
        switch (this.parsingContext) {
            case ParsingContext.SourceElements:
                this.skipUntil(isSourceElementsRecoveryToken);
                break;

            case ParsingContext.Parameters:
                this.skipUntil(isParametersRecoveryToken);
                if (this.token === SyntaxKind.LineTerminatorToken) {
                    this.nextToken();
                }

                break;

            case ParsingContext.BracketedParameters:
                this.skipUntil(isBracketedParametersRecoveryToken);
                if (this.token === SyntaxKind.LineTerminatorToken) {
                    this.nextToken();
                }

                break;

            case ParsingContext.Arguments:
                this.skipUntil(isArgumentsRecoveryToken);
                if (this.token === SyntaxKind.LineTerminatorToken) {
                    this.nextToken();
                }

                break;

            case ParsingContext.BracketedArguments:
                this.skipUntil(isBracketedArgumentsRecoveryToken);
                if (this.token === SyntaxKind.LineTerminatorToken) {
                    this.nextToken();
                }

                break;

            case ParsingContext.RightHandSideListIndented:
                this.skipUntil(isRightHandSideListIndentedRecoveryToken);
                break;

            case ParsingContext.SymbolSet:
                this.skipUntil(isSymbolSetRecoveryToken);
                if (this.token === SyntaxKind.LineTerminatorToken) {
                    this.nextToken();
                }

                break;

            case ParsingContext.OneOfList:
                this.skipUntil(isOneOfListRecoveryToken);
                break;

            case ParsingContext.OneOfListIndented:
                this.skipUntil(isOneOfListIndentedRecoveryToken);
                if (this.token === SyntaxKind.LineTerminatorToken) {
                    this.nextToken();
                }

                break;

            case ParsingContext.OneOfSymbolList:
                this.skipUntil(isOneOfSymbolListRecoveryToken);
                break;

            case ParsingContext.NoSymbolHere:
                this.skipUntil(isNoSymbolHereRecoveryToken);
                break;
        }
    }

    private reportDiagnostics(): void {
        switch (this.parsingContext) {
            case ParsingContext.SourceElements:
                this.diagnostics.report(this.scanner.getTokenPos(), Diagnostics.Production_expected);
                break;

            case ParsingContext.Parameters:
            case ParsingContext.Arguments:
                this.diagnostics.report(this.scanner.getTokenPos(), Diagnostics._0_expected, formatList([SyntaxKind.CommaToken, SyntaxKind.CloseParenToken]));
                break;

            case ParsingContext.BracketedParameters:
            case ParsingContext.BracketedArguments:
                this.diagnostics.report(this.scanner.getTokenPos(), Diagnostics._0_expected, formatList([SyntaxKind.CommaToken, SyntaxKind.CloseBracketToken]));
                break;

            case ParsingContext.SymbolSet:
                this.diagnostics.report(this.scanner.getTokenPos(), Diagnostics._0_expected, formatList([SyntaxKind.CommaToken, SyntaxKind.CloseBraceToken]));
                break;

            case ParsingContext.OneOfList:
                this.diagnostics.report(this.scanner.getTokenPos(), Diagnostics._0_expected, formatList([SyntaxKind.Terminal, SyntaxKind.LineTerminatorToken]));
                break;

            case ParsingContext.OneOfListIndented:
                this.diagnostics.report(this.scanner.getTokenPos(), Diagnostics._0_expected, formatList([SyntaxKind.Terminal, SyntaxKind.DedentToken]));
                break;

            case ParsingContext.RightHandSideListIndented:
                this.diagnostics.report(this.scanner.getTokenPos(), Diagnostics.Production_expected);
                break;
        }
    }

    private hasCloseToken() {
        switch (this.parsingContext) {
            case ParsingContext.OneOfSymbolList:
            case ParsingContext.NoSymbolHere:
                return false;
        }

        return true;
    }

    private isOnCloseToken() {
        switch (this.parsingContext) {
            case ParsingContext.SourceElements:
                return this.token === SyntaxKind.EndOfFileToken;

            case ParsingContext.Parameters:
            case ParsingContext.Arguments:
                return this.token === SyntaxKind.CloseParenToken;

            case ParsingContext.BracketedParameters:
            case ParsingContext.BracketedArguments:
                return this.token === SyntaxKind.CloseBracketToken;

            case ParsingContext.RightHandSideListIndented:
                return this.token === SyntaxKind.DedentToken || this.token === SyntaxKind.EndOfFileToken;

            case ParsingContext.SymbolSet:
                return this.token === SyntaxKind.CloseBraceToken;

            case ParsingContext.OneOfList:
                return this.token === SyntaxKind.DedentToken || this.token === SyntaxKind.LineTerminatorToken || this.token === SyntaxKind.EndOfFileToken;

            case ParsingContext.OneOfListIndented:
                return this.token === SyntaxKind.DedentToken || this.token === SyntaxKind.EndOfFileToken;

            case ParsingContext.OneOfSymbolList:
                return false;

            case ParsingContext.NoSymbolHere:
                return this.token === SyntaxKind.HereKeyword;
        }
    }

    private parseCloseToken() {
        if (this.isOnCloseToken()) {
            this.nextToken();
            return true;
        }

        return false;
    }

    private hasSeparator() {
        switch (this.parsingContext) {
            case ParsingContext.SourceElements:
            case ParsingContext.OneOfList:
            case ParsingContext.OneOfListIndented:
                return false;

            default:
                return true;
        }
    }

    private isOnSeparator() {
        switch (this.parsingContext) {
            case ParsingContext.Parameters:
            case ParsingContext.BracketedParameters:
            case ParsingContext.Arguments:
            case ParsingContext.BracketedArguments:
            case ParsingContext.SymbolSet:
                return this.token === SyntaxKind.CommaToken;

            case ParsingContext.RightHandSideListIndented:
                return this.token === SyntaxKind.LineTerminatorToken;

            case ParsingContext.OneOfSymbolList:
            case ParsingContext.NoSymbolHere:
                return this.token === SyntaxKind.OrKeyword;

            case ParsingContext.SourceElements:
            case ParsingContext.OneOfList:
            case ParsingContext.OneOfListIndented:
                return false;
        }
    }

    private parseSeparator() {
        if (this.isOnSeparator()) {
            this.nextToken();
            return true;
        }

        return false;
    }

    private parseList<TParsingContext extends ParsingContext>(listContext: TParsingContext, result?: ListTypes[TParsingContext][]): ListTypes[TParsingContext][] | undefined {
        const saveContext = this.parsingContext;
        this.parsingContext = listContext;
        const hasCloseToken = this.hasCloseToken();
        const hasSeparator = this.hasSeparator();
        const shouldConsumeCloseToken = this.shouldConsumeCloseToken();
        const whitespaceToSkip = this.shouldSkipWhitespace();
        while (!this.isEOF()) {
            this.cancellationToken.throwIfCancellationRequested();
            this.skipWhitespace(whitespaceToSkip);

            let parsed = false;
            if (this.shouldParseElement()) {
                parsed = true;
                if (!result) {
                    result = [];
                }

                const element = this.parseElement(listContext);
                if (element) {
                    result.push(element);
                }
                else {
                    this.recover();
                }
            }

            if (hasCloseToken && (shouldConsumeCloseToken ? this.parseCloseToken() : this.isOnCloseToken())) {
                break;
            }

            if (!(hasSeparator ? this.parseSeparator() : parsed)) {
                if (!hasCloseToken) {
                    break;
                }
                else {
                    this.reportDiagnostics();
                    this.recover();
                }
            }
        }

        this.parsingContext = saveContext;
        return result;
    }

    private canBeIdentifier(kind: SyntaxKind): boolean {
        if (kind === SyntaxKind.Identifier) {
            return true;
        }

        return kind >= SyntaxKind.FirstKeyword && kind <= SyntaxKind.LastKeyword;
    }

    private parseIdentifier(): Identifier {
        const fullStart = this.scanner.getStartPos();
        const text = this.canBeIdentifier(this.token) ? this.readTokenValue(this.token) : undefined;
        const node = new Identifier(text);
        return this.finishNode(node, fullStart);
    }

    private parseUnicodeCharacterLiteral(allowOptional: boolean): UnicodeCharacterLiteral {
        const fullStart = this.scanner.getStartPos();
        const text = this.readTokenText(SyntaxKind.UnicodeCharacterLiteral);
        const questionToken = allowOptional ? this.parseToken(SyntaxKind.QuestionToken) : undefined;
        const node = new UnicodeCharacterLiteral(text, questionToken);
        return this.finishNode(node, fullStart);
    }

    private parseProse(greaterThanToken: Token<SyntaxKind.GreaterThanToken>): Prose {
        const fragments = this.parseProseFragments();
        const node = new Prose(greaterThanToken, fragments);
        this.finishNode(node, greaterThanToken.pos);
        return node;
    }

    private isStartOfParameter(): boolean {
        return this.canBeIdentifier(this.token);
    }

    private parseParameter(): Parameter {
        const fullStart = this.scanner.getStartPos();
        const name = this.parseIdentifier();
        const node = new Parameter(name);
        this.finishNode(node, fullStart);
        return node;
    }

    private parseParameterListTail(openToken: Token<SyntaxKind.OpenParenToken | SyntaxKind.OpenBracketToken>, parsingContext: ParsingContext.Parameters | ParsingContext.BracketedParameters, closeTokenKind: SyntaxKind.CloseParenToken | SyntaxKind.CloseBracketToken): ParameterList {
        const elements = this.parseList(parsingContext);
        const closeToken = this.parseToken(closeTokenKind);
        const node = new ParameterList(openToken, elements, closeToken);
        return this.finishNode(node, openToken.pos);
    }

    private tryParseParameterList(): ParameterList | undefined {
        const openParenToken = this.parseToken(SyntaxKind.OpenParenToken);
        if (openParenToken) {
            return this.parseParameterListTail(openParenToken, ParsingContext.Parameters, SyntaxKind.CloseParenToken);
        }

        const openBracketToken = this.parseToken(SyntaxKind.OpenBracketToken);
        if (openBracketToken) {
            return this.parseParameterListTail(openBracketToken, ParsingContext.BracketedParameters, SyntaxKind.CloseBracketToken);
        }

        return undefined;
    }

    private parseOneOfList(oneKeyword: Token<SyntaxKind.OneKeyword>): OneOfList {
        const ofKeyword = this.parseToken(SyntaxKind.OfKeyword);
        this.parseOptional(SyntaxKind.LineTerminatorToken);

        const openIndentToken = this.parseToken(SyntaxKind.IndentToken);
        const terminals = this.parseList(openIndentToken ? ParsingContext.OneOfListIndented : ParsingContext.OneOfList);
        const closeIndentToken = this.parseToken(SyntaxKind.DedentToken);
        const node = new OneOfList(oneKeyword, ofKeyword, openIndentToken, terminals, closeIndentToken);
        return this.finishNode(node, oneKeyword.pos);
    }

    private parseSymbolSetTail(openBraceToken: Token<SyntaxKind.OpenBraceToken>): SymbolSet {
        const terminals = this.parseList(ParsingContext.SymbolSet);
        const closeBraceToken = this.parseToken(SyntaxKind.CloseBraceToken);
        const node = new SymbolSet(openBraceToken, terminals, closeBraceToken);
        return this.finishNode(node, openBraceToken.pos);
    }

    private parseSymbolSpanRestOrSymbolSet(): SymbolSpan | SymbolSet {
        const openBraceToken = this.parseToken(SyntaxKind.OpenBraceToken);
        if (openBraceToken) {
            return this.parseSymbolSetTail(openBraceToken);
        }
        else {
            return this.parseSymbolSpanRest();
        }
    }

    private parseEmptyAssertionTail(openBracketToken: Token<SyntaxKind.OpenBracketToken>, emptyKeyword: Token<SyntaxKind.EmptyKeyword>): EmptyAssertion {
        const closeBracketToken = this.parseToken(SyntaxKind.CloseBracketToken);
        const node = new EmptyAssertion(openBracketToken, emptyKeyword, closeBracketToken);
        return this.finishNode(node, openBracketToken.pos);
    }

    private parseLookaheadAssertionTail(openBracketToken: Token<SyntaxKind.OpenBracketToken>, lookaheadKeyword: Token<SyntaxKind.LookaheadKeyword>): LookaheadAssertion {
        const operatorToken = this.parseAnyToken(isLookaheadOperatorToken);
        const lookahead = this.parseSymbolSpanRestOrSymbolSet();
        const closeBracketToken = this.parseToken(SyntaxKind.CloseBracketToken);
        const node = new LookaheadAssertion(openBracketToken, lookaheadKeyword, operatorToken, lookahead, closeBracketToken);
        return this.finishNode(node, openBracketToken.pos);
    }

    private parseNoSymbolHereAssertionTail(openBracketToken: Token<SyntaxKind.OpenBracketToken>, noKeyword: Token<SyntaxKind.NoKeyword>): NoSymbolHereAssertion {
        const symbols = this.parseList(ParsingContext.NoSymbolHere);
        const hereKeyword = this.parseToken(SyntaxKind.HereKeyword);
        const closeBracketToken = this.parseToken(SyntaxKind.CloseBracketToken);
        const node = new NoSymbolHereAssertion(openBracketToken, noKeyword, symbols, hereKeyword, closeBracketToken);
        return this.finishNode(node, openBracketToken.pos);
    }

    private parseLexicalGoalAssertionTail(openBracketToken: Token<SyntaxKind.OpenBracketToken>, lexicalKeyword: Token<SyntaxKind.LexicalKeyword>): LexicalGoalAssertion {
        const goalKeyword = this.parseToken(SyntaxKind.GoalKeyword);
        const symbol = this.parseIdentifier();
        const closeBracketToken = this.parseToken(SyntaxKind.CloseBracketToken);
        const node = new LexicalGoalAssertion(openBracketToken, lexicalKeyword, goalKeyword, symbol, closeBracketToken);
        return this.finishNode(node, openBracketToken.pos);
    }

    private parseParameterValueAssertionTail(openBracketToken: Token<SyntaxKind.OpenBracketToken>, operatorToken: Token<ParameterOperatorKind>): ParameterValueAssertion {
        const name = this.parseIdentifier();
        const closeBracketToken = this.parseToken(SyntaxKind.CloseBracketToken);
        const node = new ParameterValueAssertion(openBracketToken, operatorToken, name, closeBracketToken);
        return this.finishNode(node, openBracketToken.pos);
    }

    private parseInvalidAssertionTail(openBracketToken: Token<SyntaxKind.OpenBracketToken>): Assertion {
        const fullStart = this.scanner.getStartPos();
        this.skipUntil(isInvalidConstraintTailRecoveryToken);
        const closeBracketToken = this.parseToken(SyntaxKind.CloseBracketToken);
        const node = new InvalidAssertion(openBracketToken, closeBracketToken);
        this.finishNode(node, fullStart);
        return node;
    }

    private parseAssertion(openBracketToken: Token<SyntaxKind.OpenBracketToken>): Assertion {
        const emptyKeyword = this.parseToken(SyntaxKind.EmptyKeyword);
        if (emptyKeyword) {
            return this.parseEmptyAssertionTail(openBracketToken, emptyKeyword);
        }

        const lookaheadKeyword = this.parseToken(SyntaxKind.LookaheadKeyword);
        if (lookaheadKeyword) {
            return this.parseLookaheadAssertionTail(openBracketToken, lookaheadKeyword);
        }

        const noKeyword = this.parseToken(SyntaxKind.NoKeyword);
        if (noKeyword) {
            return this.parseNoSymbolHereAssertionTail(openBracketToken, noKeyword);
        }

        const lexicalKeyword = this.parseToken(SyntaxKind.LexicalKeyword);
        if (lexicalKeyword) {
            return this.parseLexicalGoalAssertionTail(openBracketToken, lexicalKeyword);
        }

        const operatorToken = this.parseAnyToken(isParameterOperatorToken);
        if (operatorToken) {
            return this.parseParameterValueAssertionTail(openBracketToken, operatorToken);
        }

        return this.parseInvalidAssertionTail(openBracketToken);
    }

    private parseProseAssertion(openBracketToken: Token<SyntaxKind.OpenBracketGreaterThanToken>): ProseAssertion {
        const fragments = this.parseProseFragments();
        const closeBracketToken = this.parseToken(SyntaxKind.CloseBracketToken);
        const node = new ProseAssertion(openBracketToken, fragments, closeBracketToken);
        return this.finishNode(node, openBracketToken.pos);
    }

    private parseProseFragments() {
        let fragments: (ProseFragmentLiteral | Terminal | Nonterminal)[] | undefined;
        while (this.token) {
            if (this.token === SyntaxKind.ProseFull) {
                if (!fragments) fragments = [];
                fragments.push(this.parseProseFragmentLiteral(this.token));
                break;
            }
            else if (this.token >= SyntaxKind.FirstProseFragment && this.token <= SyntaxKind.LastProseFragment) {
                if (!fragments) fragments = [];
                fragments.push(this.parseProseFragmentLiteral(this.token));
            }
            else if (this.token === SyntaxKind.Terminal) {
                if (!fragments) fragments = [];
                fragments.push(this.parseTerminal(/*allowOptional*/ false));
            }
            else if (this.token === SyntaxKind.Identifier) {
                if (!fragments) fragments = [];
                fragments.push(this.parseNonterminal(/*allowArgumentList*/ false, /*allowOptional*/ false));
            }
            else {
                break;
            }
        }

        return fragments;
    }

    private parseProseFragmentLiteral(token: SyntaxKind) {
        const fullStart = this.scanner.getStartPos();
        const text = this.readTokenValue(token);
        const node = new ProseFragmentLiteral(token, text);
        return this.finishNode(node, fullStart);
    }

    private parseTerminal(allowOptional: boolean): Terminal {
        const fullStart = this.scanner.getStartPos();
        const text = this.readTokenValue(SyntaxKind.Terminal);
        const questionToken = allowOptional ? this.parseToken(SyntaxKind.QuestionToken) : undefined;
        const node = new Terminal(text, questionToken);
        this.finishNode(node, fullStart);
        return node;
    }

    private isStartOfArgument(): boolean {
        return isLeadingArgumentToken(this.token)
            || this.canBeIdentifier(this.token);
    }

    private parseArgument(): Argument {
        const fullStart = this.scanner.getStartPos();
        const operatorToken = this.parseAnyToken(isLeadingArgumentToken);
        const name = this.parseIdentifier();
        const node = new Argument(operatorToken, name);
        this.finishNode(node, fullStart);
        return node;
    }

    private parseArgumentListTail(openToken: Token<SyntaxKind.OpenParenToken | SyntaxKind.OpenBracketToken>, parsingContext: ParsingContext.Arguments | ParsingContext.BracketedArguments, closeTokenKind: SyntaxKind.CloseParenToken | SyntaxKind.CloseBracketToken): ArgumentList {
        const elements = this.parseList(parsingContext);
        const closeToken = this.parseToken(closeTokenKind);
        const node = new ArgumentList(openToken, elements, closeToken);
        this.finishNode(node, openToken.pos);
        return node;
    }

    private tryParseArgumentList(): ArgumentList | undefined {
        const openParenToken = this.parseToken(SyntaxKind.OpenParenToken);
        if (openParenToken) {
            return this.parseArgumentListTail(openParenToken, ParsingContext.Arguments, SyntaxKind.CloseParenToken);
        }

        if (this.isStartOfArgumentList()) {
            const openBracketToken = this.parseToken(SyntaxKind.OpenBracketToken);
            if (openBracketToken) {
                return this.parseArgumentListTail(openBracketToken, ParsingContext.BracketedArguments, SyntaxKind.CloseBracketToken);
            }
        }

        return undefined;
    }

    private isStartOfArgumentList(): boolean {
        if (this.token === SyntaxKind.OpenBracketToken) {
            return this.lookahead(() => this.nextTokenIsArgument());
        }

        return false;
    }

    private nextTokenIsArgument(): boolean {
        this.nextToken();
        return isLeadingArgumentToken(this.token)
            || this.token === SyntaxKind.Identifier;
    }

    private parseNonterminal(allowArgumentList: boolean, allowOptional: boolean): Nonterminal {
        const fullStart = this.scanner.getStartPos();
        const name = this.parseIdentifier();
        const argumentList = allowArgumentList ? this.tryParseArgumentList() : undefined;
        const questionToken = allowOptional ? this.parseToken(SyntaxKind.QuestionToken) : undefined;
        const node = new Nonterminal(name, argumentList, questionToken);
        this.finishNode(node, fullStart);
        return node;
    }

    private parseOneOfSymbol(oneKeyword: Token<SyntaxKind.OneKeyword>): OneOfSymbol {
        const ofKeyword = this.parseToken(SyntaxKind.OfKeyword);
        const symbols = this.parseList(ParsingContext.OneOfSymbolList);
        const node = new OneOfSymbol(oneKeyword, ofKeyword, symbols);
        this.finishNode(node, oneKeyword.pos);
        return node;
    }

    private parsePlaceholderSymbol(placeholderToken: Token<SyntaxKind.AtToken>): LexicalSymbol {
        const node = new PlaceholderSymbol(placeholderToken);
        this.finishNode(node, placeholderToken.pos);
        return node;
    }

    private parseInvalidSymbol(): LexicalSymbol {
        const fullStart = this.scanner.getStartPos();
        const node = new InvalidSymbol();
        this.skipUntil(isInvalidSymbolRecoveryToken);
        return this.finishNode(node, fullStart);
    }

    private parseUnicodeCharacterRangeOrHigher(allowOptional: boolean): UnicodeCharacterLiteral | UnicodeCharacterRange {
        const symbol = this.parseUnicodeCharacterLiteral(allowOptional);
        if (!allowOptional) {
            const throughKeyword = this.parseToken(SyntaxKind.ThroughKeyword);
            if (throughKeyword) {
                return this.parseUnicodeCharacterRangeTail(symbol, throughKeyword);
            }
        }
        return symbol;
    }

    private parseUnicodeCharacterRangeTail(left: UnicodeCharacterLiteral, throughKeyword: Token<SyntaxKind.ThroughKeyword>): UnicodeCharacterRange {
        const right = this.parseUnicodeCharacterLiteral(/*allowOptional*/ false);
        const node = new UnicodeCharacterRange(left, throughKeyword, right);
        this.finishNode(node, left.pos);
        return node;
    }

    private parsePrimarySymbol(allowOptional: boolean): LexicalSymbol {
        switch (this.token) {
            case SyntaxKind.UnicodeCharacterLiteral:
                return this.parseUnicodeCharacterRangeOrHigher(allowOptional);

            case SyntaxKind.Terminal:
                return this.parseTerminal(allowOptional);

            case SyntaxKind.Identifier:
                return this.parseNonterminal(/*allowArgumentList*/ true, allowOptional);
        }

        const placeholderToken = this.parseToken(SyntaxKind.AtToken);
        if (placeholderToken) {
            return this.parsePlaceholderSymbol(placeholderToken);
        }

        return this.parseInvalidSymbol();
    }

    private parseUnarySymbol(): LexicalSymbol {
        const oneKeyword = this.parseToken(SyntaxKind.OneKeyword);
        if (oneKeyword) {
            return this.parseOneOfSymbol(oneKeyword);
        }

        return this.parsePrimarySymbol(/*allowOptional*/ true);
    }

    private parseButNotSymbolTail(left: LexicalSymbol, butKeyword: Token<SyntaxKind.ButKeyword> | undefined, notKeyword: Token<SyntaxKind.NotKeyword> | undefined): ButNotSymbol {
        const right = this.parseSymbol();
        const node = new ButNotSymbol(left, butKeyword, notKeyword, right);
        this.finishNode(node, left.pos);
        return node;
    }

    private parseSymbol(): LexicalSymbol {
        const openBracketToken = this.parseToken(SyntaxKind.OpenBracketToken);
        if (openBracketToken) {
            return this.parseAssertion(openBracketToken);
        }

        const openBracketGreaterThanToken = this.parseToken(SyntaxKind.OpenBracketGreaterThanToken);
        if (openBracketGreaterThanToken) {
            return this.parseProseAssertion(openBracketGreaterThanToken);
        }

        const symbol = this.parseUnarySymbol();
        const butKeyword = this.parseToken(SyntaxKind.ButKeyword);
        const notKeyword = this.parseToken(SyntaxKind.NotKeyword);
        if (butKeyword || notKeyword) {
            return this.parseButNotSymbolTail(symbol, butKeyword, notKeyword);
        }

        return symbol;
    }

    private tryParseSymbolSpan(): SymbolSpan | undefined {
        if (this.isStartOfSymbolSpan()) {
            return this.parseSymbolSpanRest();
        }

        return undefined;
    }

    private parseSymbolSpanRest(): SymbolSpan {
        const fullStart = this.scanner.getStartPos();
        const symbol = this.parseSymbol();
        const next = this.tryParseSymbolSpan();
        const node = new SymbolSpan(symbol, next);
        this.finishNode(node, fullStart);
        return node;
    }

    private parseSymbolSpan(): SymbolSpan {
        const greaterThanToken = this.parseToken(SyntaxKind.GreaterThanToken);
        if (greaterThanToken) {
            const symbol = this.parseProse(greaterThanToken);
            const node = new SymbolSpan(symbol, /*next*/ undefined);
            this.finishNode(node, greaterThanToken.pos);
            return node;
        }
        else {
            return this.parseSymbolSpanRest();
        }
    }

    private isStartOfSymbolSpan(): boolean {
        switch (this.token) {
            case SyntaxKind.UnicodeCharacterLiteral:
            case SyntaxKind.Terminal:
            case SyntaxKind.Identifier:
            case SyntaxKind.OpenBracketToken:
            case SyntaxKind.OpenBracketGreaterThanToken:
            case SyntaxKind.GreaterThanToken:
            case SyntaxKind.AtToken:
                return true;

            default:
                return false;
        }
    }

    private isStartOfRightHandSide(): boolean {
        return this.isStartOfSymbolSpan();
    }

    private parseLinkReference(): LinkReference | undefined {
        if (this.token === SyntaxKind.LinkReference) {
            const fullStart = this.scanner.getStartPos();
            const text = this.readTokenValue(SyntaxKind.LinkReference);
            const node = new LinkReference(text);
            return this.finishNode(node, fullStart);
        }

        return undefined;
    }

    private parseRightHandSide(): RightHandSide {
        const fullStart = this.scanner.getStartPos();
        const head = this.parseSymbolSpan();
        const reference = this.parseLinkReference();
        const node = new RightHandSide(head, reference);

        let parsedLineTerminator = false;
        if (this.parsingContext !== ParsingContext.RightHandSideListIndented) {
            parsedLineTerminator = this.parseOptional(SyntaxKind.LineTerminatorToken);
        }

        this.finishNode(node, fullStart);
        // Fix order due to newline
        if (parsedLineTerminator && node.trailingHtmlTrivia) {
            node.trailingHtmlTrivia = stableSort(node.trailingHtmlTrivia, trivia => trivia.pos);
        }
        return node;
    }

    private parseRightHandSideList(): RightHandSideList {
        const fullStart = this.scanner.getStartPos();
        const openIndentToken = this.parseToken(SyntaxKind.IndentToken);
        const elements = openIndentToken && this.parseList(ParsingContext.RightHandSideListIndented) || [];
        const closeIndentToken = this.parseToken(SyntaxKind.DedentToken);
        const node = new RightHandSideList(openIndentToken, elements, closeIndentToken);
        return this.finishNode(node, fullStart);
    }

    private parseBody(): OneOfList | RightHandSide | RightHandSideList {
        const oneKeyword = this.parseToken(SyntaxKind.OneKeyword);
        if (oneKeyword) {
            return this.parseOneOfList(oneKeyword);
        }

        if (this.token === SyntaxKind.LineTerminatorToken) {
            this.nextToken();
            return this.parseRightHandSideList();
        }
        else {
            return this.parseRightHandSide();
        }
    }

    private parseProduction(): Production {
        const fullStart = this.scanner.getStartPos();
        const name = this.parseIdentifier();
        const parameters = this.tryParseParameterList();
        const colonToken = this.parseAnyToken(isProductionSeparatorToken);
        const body = this.parseBody();
        const node = new Production(name, parameters, colonToken, body);
        this.finishNode(node, fullStart);
        return node;
    }

    private parseStringLiteral(): StringLiteral | undefined {
        if (this.token === SyntaxKind.StringLiteral) {
            const fullStart = this.scanner.getStartPos();
            const text = this.scanner.getTokenValue();
            const node = new StringLiteral(text);
            this.nextToken();
            return this.finishNode(node, fullStart);
        }

        return undefined;
    }

    private parseMetaElement(atToken: Token<SyntaxKind.AtToken>): MetaElement | undefined {
        const importKeyword = this.parseToken(SyntaxKind.ImportKeyword);
        if (importKeyword) {
            return this.parseImport(atToken, importKeyword);
        }

        const defineKeyword = this.parseToken(SyntaxKind.DefineKeyword);
        if (defineKeyword) {
            return this.parseDefine(atToken, defineKeyword);
        }

        this.diagnostics.report(this.scanner.getTokenPos(), Diagnostics._0_expected, formatList([SyntaxKind.ImportKeyword, SyntaxKind.DefineKeyword]));
        return undefined;
    }

    private parseImport(atToken: Token<SyntaxKind.AtToken>, importKeyword: Token<SyntaxKind.ImportKeyword>): Import {
        const path = this.parseStringLiteral();
        const node = new Import(atToken, importKeyword, path);
        this.finishNode(node, atToken.pos);
        if (node.path && node.path.text) this.imports.push(node.path.text);
        return node;
    }

    private parseDefine(atToken: Token<SyntaxKind.AtToken>, defineKeyword: Token<SyntaxKind.DefineKeyword>): Define {
        const key = this.parseIdentifier();
        const valueToken = this.parseAnyToken(isBooleanLiteralToken);
        const node = new Define(atToken, defineKeyword, key, valueToken);
        this.finishNode(node, atToken.pos);
        return node;
    }

    private isStartOfSourceElement(): boolean {
        switch (this.token) {
            case SyntaxKind.AtToken: // Import
            case SyntaxKind.Identifier: // Production
                return true;

            case SyntaxKind.ColonToken:
            case SyntaxKind.ColonColonToken:
            case SyntaxKind.ColonColonColonToken:
            case SyntaxKind.OpenParenToken:
                // Assume we're parsing a production for error recovery purposes
                return true;

            default:
                return false;
        }
    }

    private parseSourceElement(): SourceElement | undefined {
        if (this.token === SyntaxKind.Identifier) {
            return this.parseProduction();
        }

        const atToken = this.parseToken(SyntaxKind.AtToken);
        if (atToken) {
            return this.parseMetaElement(atToken);
        }

        this.diagnostics.report(this.scanner.getTokenPos(), Diagnostics.Unexpected_token_0_, tokenToString(this.token));
        return undefined;
    }

    private parseSourceElementList(elements?: SourceElement[]): SourceElement[] | undefined {
        return this.parseList(ParsingContext.SourceElements, elements);
    }
}

function isSourceElementsRecoveryToken(token: SyntaxKind) {
    return token === SyntaxKind.LineTerminatorToken;
}

function isParametersRecoveryToken(token: SyntaxKind) {
    return token === SyntaxKind.CommaToken
        || token === SyntaxKind.Identifier
        || token === SyntaxKind.CloseParenToken
        || token === SyntaxKind.ColonToken
        || token === SyntaxKind.ColonColonToken
        || token === SyntaxKind.ColonColonColonToken
        || token === SyntaxKind.LineTerminatorToken;
}

function isBracketedParametersRecoveryToken(token: SyntaxKind) {
    return token === SyntaxKind.CommaToken
        || token === SyntaxKind.Identifier
        || token === SyntaxKind.CloseBracketToken
        || token === SyntaxKind.ColonToken
        || token === SyntaxKind.ColonColonToken
        || token === SyntaxKind.ColonColonColonToken
        || token === SyntaxKind.LineTerminatorToken;
}

function isArgumentsRecoveryToken(token: SyntaxKind) {
    return token === SyntaxKind.CommaToken
        || token === SyntaxKind.QuestionToken
        || token === SyntaxKind.Identifier
        || token === SyntaxKind.CloseParenToken
        || token === SyntaxKind.LineTerminatorToken;
}

function isBracketedArgumentsRecoveryToken(token: SyntaxKind) {
    return token === SyntaxKind.CommaToken
        || token === SyntaxKind.QuestionToken
        || token === SyntaxKind.Identifier
        || token === SyntaxKind.CloseBracketToken
        || token === SyntaxKind.LineTerminatorToken;
}

function isRightHandSideListIndentedRecoveryToken(token: SyntaxKind) {
    return token === SyntaxKind.DedentToken
        || token === SyntaxKind.LineTerminatorToken
}

function isSymbolSetRecoveryToken(token: SyntaxKind) {
    return token === SyntaxKind.CommaToken
        || token === SyntaxKind.Terminal
        || token === SyntaxKind.CloseBraceToken
        || token === SyntaxKind.LineTerminatorToken
}

function isOneOfListRecoveryToken(token: SyntaxKind) {
    return token === SyntaxKind.Terminal
        || token === SyntaxKind.LineTerminatorToken
}

function isOneOfListIndentedRecoveryToken(token: SyntaxKind) {
    return token === SyntaxKind.Terminal
        || token === SyntaxKind.LineTerminatorToken
}

function isOneOfSymbolListRecoveryToken(token: SyntaxKind) {
    return token === SyntaxKind.OrKeyword
        || token === SyntaxKind.Terminal
        || token === SyntaxKind.Identifier
        || token === SyntaxKind.OpenBracketToken
        || token === SyntaxKind.QuestionToken
        || token === SyntaxKind.LineTerminatorToken
}

function isNoSymbolHereRecoveryToken(token: SyntaxKind) {
    return token === SyntaxKind.OrKeyword
        || token === SyntaxKind.HereKeyword
        || token === SyntaxKind.Terminal
        || token === SyntaxKind.Identifier
        || token === SyntaxKind.CloseBracketToken
        || token === SyntaxKind.QuestionToken
        || token === SyntaxKind.LineTerminatorToken
}

function isInvalidSymbolRecoveryToken(token: SyntaxKind) {
    return token === SyntaxKind.OpenBracketToken
        || token === SyntaxKind.Terminal
        || token === SyntaxKind.Identifier
        || token === SyntaxKind.LineTerminatorToken;
}

function isInvalidConstraintTailRecoveryToken(token: SyntaxKind) {
    return token === SyntaxKind.CloseBracketToken
        || token === SyntaxKind.LineTerminatorToken
        || token === SyntaxKind.Terminal
        || token === SyntaxKind.Identifier;
}

function isProductionSeparatorToken(token: SyntaxKind): token is ProductionSeperatorKind {
    return token === SyntaxKind.ColonToken
        || token === SyntaxKind.ColonColonToken
        || token === SyntaxKind.ColonColonColonToken;
}

function isLeadingArgumentToken(token: SyntaxKind): token is ArgumentOperatorKind {
    return token === SyntaxKind.QuestionToken
        || token === SyntaxKind.PlusToken
        || token === SyntaxKind.TildeToken;
}

function isParameterOperatorToken(token: SyntaxKind): token is ParameterOperatorKind {
    return token === SyntaxKind.PlusToken
        || token === SyntaxKind.TildeToken;
}

function isBooleanLiteralToken(token: SyntaxKind): token is SyntaxKind.TrueKeyword | SyntaxKind.FalseKeyword {
    return token === SyntaxKind.TrueKeyword
        || token === SyntaxKind.FalseKeyword;
}

function isLookaheadOperatorToken(token: SyntaxKind): token is LookaheadOperatorKind {
    return token === SyntaxKind.EqualsToken
        || token === SyntaxKind.EqualsEqualsToken
        || token === SyntaxKind.ExclamationEqualsToken
        || token === SyntaxKind.NotEqualToToken
        || token === SyntaxKind.LessThanMinusToken
        || token === SyntaxKind.ElementOfToken
        || token === SyntaxKind.LessThanExclamationToken
        || token === SyntaxKind.NotAnElementOfToken;
}

function matched(possibleOpenTag: HtmlTrivia, possibleCloseTag: HtmlTrivia) {
    return possibleOpenTag.kind === SyntaxKind.HtmlOpenTagTrivia
        && possibleCloseTag.kind === SyntaxKind.HtmlCloseTagTrivia
        && possibleOpenTag.tagName === possibleCloseTag.tagName;
}

function trimTrivia(trivia: HtmlTrivia[] | undefined) {
    let result: HtmlTrivia[] | undefined;
    if (trivia) {
        for (let i = 0; i < trivia.length - 1; i++) {
            if (matched(trivia[i], trivia[i + 1])) {
                if (!result) result = trivia.slice(0, i);
            }
            else if (result) {
                result.push(trivia[i]);
            }
        }
    }
    return result || trivia;
}

function attachHtmlTrivia(node: Node, leadingTags: HtmlTrivia[] | undefined, trailingTags: HtmlTrivia[] | undefined) {
    if (leadingTags) {
        let leadingTag = leadingTags.pop();
        while (leadingTag && leadingTag.kind === SyntaxKind.HtmlOpenTagTrivia) {
            (node.leadingHtmlTrivia || (node.leadingHtmlTrivia = [])).unshift(leadingTag);
            leadingTag = leadingTags.pop();
        }
        if (leadingTag) leadingTags.push(leadingTag);
    }
    if (trailingTags) {
        let trailingTag = trailingTags.shift();
        while (trailingTag && trailingTag.kind === SyntaxKind.HtmlCloseTagTrivia) {
            (node.trailingHtmlTrivia || (node.trailingHtmlTrivia = [])).push(trailingTag);
            trailingTag = trailingTags.shift();
        }
        if (trailingTag) trailingTags.unshift(trailingTag);
    }
}

function promoteHtmlTrivia(parent: Node, firstChild: Node | undefined, lastChild: Node | undefined) {
    if (firstChild && firstChild === lastChild) {
        promoteAllHtmlTrivia(parent, firstChild);
    }
    else {
        if (firstChild) promoteLeadingHtmlTrivia(parent, firstChild);
        if (lastChild) promoteTrailingHtmlTrivia(parent, lastChild);
    }
}

function promoteLeadingHtmlTrivia(parent: Node, firstChild: Node) {
    if (firstChild.leadingHtmlTrivia) {
        if (firstChild.trailingHtmlTrivia) {
            let leadingTag = firstChild.leadingHtmlTrivia.shift();
            let trailingTag = firstChild.trailingHtmlTrivia.pop();
            while (leadingTag && (!trailingTag || !matched(leadingTag, trailingTag))) {
                (parent.leadingHtmlTrivia || (parent.leadingHtmlTrivia = [])).push(leadingTag);
                leadingTag = firstChild.leadingHtmlTrivia.shift();
            }
            if (leadingTag) firstChild.leadingHtmlTrivia.unshift(leadingTag);
            if (trailingTag) firstChild.trailingHtmlTrivia.unshift(trailingTag);
        }
        else {
            parent.leadingHtmlTrivia = parent.leadingHtmlTrivia ? parent.leadingHtmlTrivia.concat(firstChild.leadingHtmlTrivia) : firstChild.leadingHtmlTrivia;
            firstChild.leadingHtmlTrivia = undefined;
        }
    }
}

function promoteTrailingHtmlTrivia(parent: Node, lastChild: Node) {
    if (lastChild.trailingHtmlTrivia) {
        if (lastChild.leadingHtmlTrivia) {
            let leadingTag = lastChild.leadingHtmlTrivia.shift();
            let trailingTag = lastChild.trailingHtmlTrivia.pop();
            while (trailingTag && (!leadingTag || !matched(leadingTag, trailingTag))) {
                (parent.trailingHtmlTrivia || (parent.trailingHtmlTrivia = [])).unshift(trailingTag);
                trailingTag = lastChild.trailingHtmlTrivia.pop();
            }
            if (leadingTag) lastChild.leadingHtmlTrivia.unshift(leadingTag);
            if (trailingTag) lastChild.trailingHtmlTrivia.unshift(trailingTag);
        }
        else {
            parent.trailingHtmlTrivia = parent.trailingHtmlTrivia ? lastChild.trailingHtmlTrivia.concat(parent.trailingHtmlTrivia) : lastChild.trailingHtmlTrivia;
            lastChild.trailingHtmlTrivia = undefined;
        }
    }
}

function promoteAllHtmlTrivia(parent: Node, onlyChild: Node) {
    if (onlyChild.leadingHtmlTrivia) {
        parent.leadingHtmlTrivia = parent.leadingHtmlTrivia ? parent.leadingHtmlTrivia.concat(onlyChild.leadingHtmlTrivia) : onlyChild.leadingHtmlTrivia;
        onlyChild.leadingHtmlTrivia = undefined;
    }
    if (onlyChild.trailingHtmlTrivia) {
        parent.trailingHtmlTrivia = parent.trailingHtmlTrivia ? onlyChild.trailingHtmlTrivia.concat(parent.trailingHtmlTrivia) : onlyChild.trailingHtmlTrivia;
        onlyChild.trailingHtmlTrivia = undefined;
    }
}