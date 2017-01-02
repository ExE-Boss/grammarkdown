import { readFileSync } from "fs";
import { Dictionary } from "./core";
import { CharacterCodes } from "./tokens";

export enum EmitFormat {
    markdown,
    html,
    ecmarkup
}

export interface CompilerOptions {
    noChecks?: boolean;
    noEmit?: boolean;
    noEmitOnError?: boolean;
    noStrictParametricProductions?: boolean;
    format?: EmitFormat;
    out?: string;
    emitLinks?: boolean;
    diagnostics?: boolean;
}

export function getDefaultOptions(): CompilerOptions {
    return { format: EmitFormat.markdown };
}

export interface KnownOptions {
    [name: string]: KnownOption;
}

export interface KnownOption {
    shortName?: string;
    longName?: string;
    param?: string;
    type?: string | { [key: string]: any; };
    many?: boolean;
    description?: string;
    error?: string;
    aliasFor?: string[];
    hidden?: boolean;
    isUsage?: boolean;
    validate?: (key: string, value: string, raw: RawArguments) => boolean;
    convert?: (key: string, value: string, raw: RawArguments) => any;
}

interface KnownOptionMaps {
    longNames: Dictionary<KnownOption>;
    shortNames: Dictionary<KnownOption>;
}

export interface RawArgument {
    rawKey: string;
    formattedKey: string;
    value: any;
    option: KnownOption;
}

export interface RawArguments {
    args: RawArgument[];
    rest: string[];
}

export interface ParsedArguments {
    [key: string]: any;
    argv: string[];
    rest: string[];
}

export function parse<T extends ParsedArguments>(options: KnownOptions, args: string[] = process.argv.slice(2)): T {
    const known = createKnownOptionMaps(new Dictionary<KnownOption>(options));
    const raw: RawArguments = { args: [], rest: [] };
    const messages: string[] = [];
    let result: ParseResult
    result = parseArguments(args, known, raw, messages);
    if (result === ParseResult.Success) {
        result = expandArguments(known, raw, messages);
        if (result === ParseResult.Success) {
            Object.freeze(raw.rest);
            Object.freeze(raw.args);
            Object.freeze(raw);
            const parsed: T = <T>{ argv: args.slice(0) };
            result = evaluateArguments(parsed, known, raw, messages);
            if (result === ParseResult.Success) {
                return parsed;
            }
        }
    }

    printErrors(messages);
}

const emptyArray: any[] = [];

export class UsageWriter {
    private margin: number;
    private padding: number;
    private remainder: number;
    private marginText: string;
    private paddingText: string;

    constructor(margin: number, padding: number) {
        this.margin = margin;
        this.padding = padding;
        this.remainder = 120 - margin - padding;
        this.marginText = padRight("", margin);
        this.paddingText = padRight("", padding);
    }

    public writeOption(left: string, right: string) {
        const leftLines = left ? this.fit(left, this.margin) : emptyArray;
        const rightLines = right ? this.fit(right, this.remainder) : emptyArray;
        const lineCount = Math.max(leftLines.length, rightLines.length);
        for (let i = 0; i < lineCount; ++i) {
            let line = "";
            if (i < leftLines.length) {
                line += leftLines[i];
            }
            if (i < rightLines.length) {
                line = padRight(line, this.margin + this.padding);
                line += rightLines[i];
            }

            console.log(line);
        }
    }

    public writeln(text: string = "") {
        console.log(text);
    }

    private fit(text: string, width: number) {
        const lines: string[] = [];
        let pos = 0, len = text.length;
        while (pos < len) {
            const ch = text.charCodeAt(pos);
            if (ch === CharacterCodes.CarriageReturn || ch === CharacterCodes.LineFeed) {
                pos++;
                if (ch === CharacterCodes.CarriageReturn && pos < len && text.charCodeAt(pos) === CharacterCodes.LineFeed) {
                    pos++;
                }

                lines.push("");
                continue;
            }

            let end = pos + width;
            if (end >= len) {
                lines.push(text.substr(pos));
                break;
            }

            while (end > pos && !isWhiteSpace(text.charCodeAt(end))) end--;
            while (end > pos && isWhiteSpace(text.charCodeAt(end), true)) end--;

            if (end <= pos) {
                lines.push(text.substr(pos, width));
                pos += width;
            }
            else {
                lines.push(text.substring(pos, end));
                pos = end;
            }

            while (pos < len && isWhiteSpace(text.charCodeAt(pos), true)) pos++;
        }

        return lines;
    }
}

export function usage(options: KnownOptions, margin: number = 0, printHeader?: (writer: UsageWriter) => void) {
    const optionsDictionary = new Dictionary<KnownOption>(options);
    const knownOptions: KnownOption[] = [];
    let hasShortNames = false;
    for (const key in optionsDictionary) {
        const option = importKnownOption(key, optionsDictionary[key]);
        if (option.hidden) {
            continue;
        }

        let size = option.longName.length + 3;
        if (option.shortName) {
            hasShortNames = true;
            size += 4;
        }

        if (option.param) {
            size += 1;
        }

        if (size > margin) {
            margin = size;
        }

        knownOptions.push(option);
    }

    const writer = new UsageWriter(margin, 1);
    if (printHeader) {
        printHeader(writer);
    }

    knownOptions.sort(compareKnownOptions);

    const descriptionSize = 120 - margin;
    const marginText = padRight("", margin);
    for (const option of knownOptions) {
        let left = " ";
        if (option.shortName) {
            left += `-${option.shortName}, `;
        }
        else if (hasShortNames) {
            left += "    ";
        }

        left += `--${option.longName}`;
        if (option.param) {
            left += ` ${option.param}`;
        }

        left = padRight(left, margin);
        writer.writeOption(left, option.description);
    }
}

function padLeft(text: string, size: number, char: string = " ") {
    while (text.length < size) text = char + text;
    return text;
}

function padRight(text: string, size: number, char: string = " ") {
    while (text.length < size) text += char;
    return text;
}

function printErrors(messages: string[]) {
    for (const message of messages) {
        console.error(message);
    }
}

function compareKnownOptions(x: KnownOption, y: KnownOption) {
    const xName = x.longName.toLowerCase();
    const yName = y.longName.toLowerCase();
    return xName.localeCompare(yName);
}

function importTypeMap(dict: Dictionary<any>) {
    const copy = Dictionary.turn(dict, (memo, value, key) => Dictionary.set(memo, String(key), value), new Dictionary<any>());
    Object.freeze(copy);
    return copy;
}

function importKnownOption(key: string, option: KnownOption) {
    const copy: KnownOption = { longName: key };
    if (typeof option.longName === "string") copy.longName = option.longName;
    if (typeof option.shortName === "string" && option.shortName.length > 0) copy.shortName = option.shortName.substr(0, 1);
    if (typeof option.param === "string") copy.param = option.param;
    if (typeof option.type === "string") copy.type = option.type;
    if (typeof option.type === "object") copy.type = importTypeMap(<Dictionary<any>>option.type);
    if (typeof option.many === "boolean") copy.many = option.many;
    if (typeof option.description === "string") copy.description = option.description;
    if (typeof option.error === "string") copy.error = option.error;
    if (typeof option.aliasFor === "string") copy.aliasFor = option.aliasFor;
    if (typeof option.hidden === "boolean" && option.hidden) copy.hidden = option.hidden;
    if (typeof option.isUsage === "boolean" && option.isUsage) copy.isUsage = option.isUsage;
    if (typeof option.validate === "function") copy.validate = option.validate;
    if (typeof option.convert === "function") copy.convert = option.convert;
    Object.freeze(copy);
    return copy;
}

function createKnownOptionMaps(options: Dictionary<KnownOption>): KnownOptionMaps {
    const longNames = new Dictionary<KnownOption>();
    const shortNames = new Dictionary<KnownOption>();
    for (const key in options) {
        const rawOption = options[key];
        if (rawOption) {
            const knownOption = importKnownOption(key, rawOption);
            Dictionary.set(longNames, knownOption.longName.toLowerCase(), knownOption);
            if (knownOption.shortName) {
                Dictionary.set(shortNames, knownOption.shortName, knownOption);
            }
        }
    }

    const maps: KnownOptionMaps = { longNames, shortNames };
    Object.freeze(longNames);
    Object.freeze(shortNames);
    Object.freeze(maps);
    return maps;
}

enum ParseResult {
    Success,
    Error
}

function parseArguments(args: string[], known: KnownOptionMaps, raw: RawArguments, messages: string[]) {
    let argc = args.length, argi = 0;
    while (argi < argc) {
        let arg = args[argi++];
        let ch = arg.charCodeAt(0);
        if (ch === CharacterCodes.At) {
            const result = parseResponseFile(arg.substr(1), known, raw, messages)
            if (result !== ParseResult.Success) {
                return result;
            }
        }
        else if (ch === CharacterCodes.Minus) {
            ch = arg.charCodeAt(1);
            const colonIndex = arg.indexOf(":");
            const hasInlineValue = colonIndex > 0;
            const shortName = ch !== CharacterCodes.Minus;
            const rawKey = arg.substring(shortName ? 1 : 2, hasInlineValue ? colonIndex : arg.length);
            const match = matchKnownOption(known, rawKey, shortName);

            switch (match.cardinality) {
                case "none":
                    messages.push(`Unrecognized option: ${rawKey}.`);
                    return ParseResult.Error;

                case "many":
                    messages.push(`Unrecognized option: ${rawKey}. Did you mean:`);
                    for (const option of match.candidates) {
                        messages.push(`    --${option.longName}`);
                    }

                    return ParseResult.Error;
            }

            const option = match.option;
            const formattedKey = shortName ? "-" + option.shortName : "--" + option.longName;
            const valueRequired = optionRequiresValue(option);
            let value: string;
            if (valueRequired || hasInlineValue) {
                if (hasInlineValue) {
                    value = arg.substr(colonIndex + 1);
                }
                else {
                    if (argi >= argc) {
                        messages.push(`Option '${formattedKey}' expects an argument.`);
                        return ParseResult.Error;
                    }

                    value = args[argi++];
                }

                if (value.length > 0) {
                    ch = value.charCodeAt(0);
                    if (ch === CharacterCodes.DoubleQuote) {
                        if (value.length > 1 && value.charCodeAt(value.length - 1) === ch) {
                            value = value.substr(1, value.length - 2);
                        }
                    }
                }

                if (valueRequired) {
                    if (value.length === 0 || value === `""` || value === `''`) {
                        messages.push(`Option '${formattedKey}' expects an argument.`);
                        return ParseResult.Error;
                    }
                }
            }

            if (option.type === "boolean") {
                if (!value) {
                    value = "true";
                }
            }

            const rawArgument: RawArgument = {
                rawKey,
                formattedKey,
                value,
                option
            };

            Object.freeze(rawArgument);
            raw.args.push(rawArgument);
        }
        else {
            if (ch === CharacterCodes.DoubleQuote) {
                if (arg.length > 1 && arg.charCodeAt(arg.length - 1) === ch) {
                    arg = arg.substr(1, arg.length - 2);
                }
            }

            raw.rest.push(arg);
        }
    }

    return ParseResult.Success;
}

function parseResponseFile(file: string, known: KnownOptionMaps, raw: RawArguments, messages: string[]) {
    let text: string;
    try {
        text = readFileSync(file, "utf8");
    }
    catch (e) {
        messages.push(`File '${file}'' not found.`);
        return ParseResult.Error;
    }

    const args: string[] = [];
    let pos = 0;
    const len = text.length;
    while (pos < len) {
        let ch = text.charCodeAt(pos);
        if (isWhiteSpace(ch)) {
            pos++;
            continue;
        }

        const start = pos;
        if (ch === CharacterCodes.DoubleQuote) {
            pos++;
            while (pos < len) {
                ch = text.charCodeAt(pos);
                if (ch === CharacterCodes.DoubleQuote) {
                    break;
                }

                pos++;
            }

            args.push(text.substring(start, pos++));
        }
        else {
            pos++;
            while (pos < len) {
                ch = text.charCodeAt(pos);
                if (!isWhiteSpace(ch)) {
                    pos++;
                }
            }
            args.push(text.substring(start, pos));
        }
    }

    return parseArguments(args, known, raw, messages);
}

function isWhiteSpace(ch: number, excludeLineTerminator?: boolean) {
    switch (ch) {
        case CharacterCodes.LineFeed:
        case CharacterCodes.CarriageReturn:
            return !excludeLineTerminator;

        case CharacterCodes.Space:
        case CharacterCodes.Tab:
        case CharacterCodes.VerticalTab:
        case CharacterCodes.FormFeed:
            return true;
    }

    return false;
}

function optionRequiresValue(option: KnownOption) {
    switch (option.type) {
        case undefined:
        case "":
        case "boolean":
            return false;

        default:
            return true;
    }
}

interface KnownOptionMatchResult {
    cardinality: string;
    option?: KnownOption;
    candidates?: KnownOption[];
}

function matchKnownOption(known: KnownOptionMaps, key: string, shortName: boolean): KnownOptionMatchResult {
    if (shortName) {
        const option = Dictionary.get(known.shortNames, key);
        if (option) {
            return { cardinality: "one", option };
        }
    }
    else {
        const keyLower = key.toLowerCase();
        if (Dictionary.has(known.longNames, keyLower)) {
            const option = Dictionary.get(known.longNames, keyLower);
            if (option) {
                return { cardinality: "one", option };
            }
        }
        else {
            const keyLen = keyLower.length;
            let candidates: KnownOption[];
            let knownKey: string;
            for (knownKey in known.longNames) {
                if (Dictionary.has(known.longNames, knownKey) &&
                    knownKey.length > keyLen &&
                    knownKey.substr(0, keyLen) === keyLower) {
                    if (!candidates) {
                        candidates = [];
                    }

                    candidates.push(Dictionary.get(known.longNames, knownKey));
                }
            }

            if (candidates) {
                if (candidates.length === 1) {
                    const option = candidates[0];
                    return { cardinality: "one", option };
                }
                else if (candidates.length > 1) {
                    return { cardinality: "many", candidates };
                }
            }
        }
    }

    return { cardinality: "none" };
}

function expandArguments(known: KnownOptionMaps, raw: RawArguments, messages: string[]) {
    for (let i = 0; i < raw.args.length; ++i) {
        const arg = raw.args[i];
        const option = arg.option;
        if (option.aliasFor) {
            let args = option.aliasFor;
            if (arg.value) {
                args = args.concat([arg.value]);
            }

            if (parseArguments(args, known, raw, messages) === ParseResult.Error) {
                return ParseResult.Error;
            }
        }
    }

    return ParseResult.Success;
}

function evaluateArguments(parsed: ParsedArguments, known: KnownOptionMaps, raw: RawArguments, messages: string[]) {
    for (const arg of raw.args) {
        let { formattedKey, value, option } = arg;
        if (option.aliasFor) {
            continue;
        }

        let type = typeof option.type;
        if (type === "string") {
            type = <string>option.type;
        }

        if (option.validate && !option.validate(option.longName, value, raw)) {
            if (option.error) {
                messages.push(option.error);
            }
            else {
                messages.push(`Invalid argument for option '${formattedKey}'.`)
            }

            return ParseResult.Error;
        }

        let booleanValue: boolean;
        let numberValue: number;
        switch (type) {
            case "file":
            case "string":
                break;

            case "boolean":
                if (value) {
                    value = value.toLowerCase();
                    if (!/^(true|false)$/.test(value)) {
                        if (option.error) {
                            messages.push(option.error);
                        }
                        else {
                            messages.push(`Invalid argument for option '${formattedKey}'. Expected either 'true' or 'false'.`);
                        }

                        return ParseResult.Error;
                    }

                    booleanValue = value === "true";
                }
                else {
                    booleanValue = true;
                }

                break;

            case "number":
                if (value) {
                    numberValue = parseFloat(value);
                    if (isNaN(numberValue) || !isFinite(numberValue)) {
                        if (option.error) {
                            messages.push(option.error);
                        }
                        else {
                            messages.push(`Invalid argument for option '${formattedKey}'. Expected a finite number.`);
                        }

                        return ParseResult.Error;
                    }
                }

                break;

            case "object":
                if (value) {
                    const type = <Dictionary<any>>option.type;
                    let result = Dictionary.get(type, value);
                    if (result === undefined) {
                        const valueLower = (<string>value).toLowerCase();
                        result = Dictionary.get(type, valueLower);
                        if (!result) {
                            for (const key in type) {
                                if (key.toLowerCase() === valueLower) {
                                    result = Dictionary.get(type, key);
                                    break;
                                }
                            }
                        }
                    }

                    if (result === undefined) {
                        if (option.error) {
                            messages.push(option.error);
                        }
                        else {
                            messages.push(`Invalid argument for option '${formattedKey}'.`);
                        }

                        return ParseResult.Error;
                    }

                    value = result;
                }
                break;
        }

        if (option.convert) {
            value = option.convert(option.longName, value, raw);
        }
        else {
            switch (option.type) {
                case "boolean":
                    value = booleanValue;
                    break;

                case "number":
                    value = numberValue;
                    break;
            }
        }

        parsed[option.longName] = value;
    }

    parsed.rest = raw.rest.slice(0);
    return ParseResult.Success;
}