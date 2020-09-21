import { compare, compareNumbers } from "./core";
import { SourceFile } from "./nodes";
import { RegionMap } from "./regionMap";
import { Position, Range } from "./types";

/* @internal */
export interface SourceLine {
    line: number;
    file?: string;
}

/* @internal */
export interface LineOffset {
    generatedLine: number;
    sourceLine: SourceLine | "default";
}

function compareSourceLines(a: SourceLine | "default", b: SourceLine | "default") {
    if (a === "default") return b === "default" ? 0 : -1;
    if (b === "default") return 1;
    return compare(a.file, b.file)
        || compareNumbers(a.line, b.line);
}

/* @internal */
export function compareLineOffsets(a: LineOffset, b: LineOffset): number {
    return compareNumbers(a.generatedLine, b.generatedLine)
        || compareSourceLines(a.sourceLine, b.sourceLine);
}

function equateSourceLines(a: SourceLine | "default", b: SourceLine | "default") {
    if (a === "default") return b === "default";
    if (b === "default") return false;
    return a.line === b.line
        && a.file === b.file;
}

/* @internal */
export function equateLineOffsets(a: LineOffset, b: LineOffset): boolean {
    return a.generatedLine === b.generatedLine
        && equateSourceLines(a.sourceLine, b.sourceLine);
}

export class LineOffsetMap {
    private generatedFilesLineOffsets: RegionMap<SourceLine | "default"> | undefined;
    private sourceFilesLineOffsets: RegionMap<SourceLine | "default"> | undefined;

    /* @internal */
    public addLineOffset(sourceFile: SourceFile | string, line: number, sourceLine: SourceLine | "default") {
        const filename = typeof sourceFile === "string" ? sourceFile : sourceFile.filename;
        this.generatedFilesLineOffsets ||= new RegionMap(equateSourceLines);
        this.generatedFilesLineOffsets.addRegion(sourceFile, line, sourceLine);

        // add reverse mapping
        this.sourceFilesLineOffsets ||= new RegionMap(equateSourceLines);
        this.sourceFilesLineOffsets.addRegion(
            sourceLine === "default" || sourceLine.file === undefined ? filename : sourceLine.file,
            sourceLine === "default" ? line : sourceLine.line,
            sourceLine === "default" ? "default" : { file: filename, line });
    }

    /* @internal */
    public findLineOffset(sourceFile: SourceFile | string, position: Position) {
        const filename = typeof sourceFile === "string" ? sourceFile : sourceFile.filename;
        return this.generatedFilesLineOffsets?.findRegion(filename, position.line);
    }

    /* @internal */
    public findRawOffset(filename: string, position: Position) {
        return this.sourceFilesLineOffsets?.findRegion(filename, position.line);
    }

    /* @internal */
    public copyFrom(other: LineOffsetMap) {
        if (other.generatedFilesLineOffsets) {
            this.generatedFilesLineOffsets ||= new RegionMap(equateSourceLines);
            this.generatedFilesLineOffsets.copyFrom(other.generatedFilesLineOffsets);
        }
    }

    /**
     * Gets the effective filename of a raw position within a source file, taking into account `@line` directives.
     */
    public getEffectiveFilenameAtPosition(sourceFile: SourceFile | string, position: Position) {
        const filename = typeof sourceFile === "string" ? sourceFile : sourceFile.filename;
        const lineOffset = this.findLineOffset(filename, position);
        if (lineOffset && lineOffset.value !== "default" && lineOffset.value.file !== undefined) {
            return lineOffset.value.file;
        }
        return filename;
    }

    /**
     * Gets the effective position of a raw position within a source file, taking into account `@line` directives.
     */
    public getEffectivePosition(sourceFile: SourceFile | string, position: Position) {
        const filename = typeof sourceFile === "string" ? sourceFile : sourceFile.filename;
        const lineOffset = this.findLineOffset(filename, position);
        if (lineOffset && lineOffset.value !== "default") {
            const diff = position.line - lineOffset.line;
            const sourceLine = lineOffset.value.line + diff;
            return Position.create(sourceLine, position.character);
        }
        return position;
    }

    /**
     * Gets the effective range of a raw range within a source file, taking into account `@line` directives.
     */
    public getEffectiveRange(sourceFile: SourceFile | string, range: Range) {
        const filename = typeof sourceFile === "string" ? sourceFile : sourceFile.filename;
        const start = this.getEffectivePosition(filename, range.start);
        const end = this.getEffectivePosition(filename, range.end);
        return start !== range.start || end !== range.end ? Range.create(start, end) : range;
    }

    public getRawFilenameAtEffectivePosition(filename: string, position: Position) {
        const lineOffset = this.findRawOffset(filename, position);
        if (lineOffset && lineOffset.value !== "default" && lineOffset.value.file !== undefined) {
            return lineOffset.value.file;
        }
        return filename;
    }

    public getRawPositionFromEffectivePosition(filename: string, position: Position) {
        const lineOffset = this.findRawOffset(filename, position);
        if (lineOffset && lineOffset.value !== "default") {
            const diff = position.line - lineOffset.line;
            const sourceLine = lineOffset.value.line + diff;
            return Position.create(sourceLine, position.character);
        }
        return position;
    }

    public getRawRangeFromEffectiveRange(filename: string, range: Range) {
        const start = this.getRawPositionFromEffectivePosition(filename, range.start);
        const end = this.getRawPositionFromEffectivePosition(filename, range.end);
        return start !== range.start || end !== range.end ? Range.create(start, end) : range;
    }
}
