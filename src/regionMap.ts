import { binarySearchBy, compare, compareNumbers } from "./core";
import { SourceFile } from "./nodes";
import { SortedUniqueList } from "./sortedUniqueList";

function compareRegions<T>(a: Region<T>, b: Region<T>) {
    return compare(a.line, b.line);
}

function selectLine(a: Region<any>) {
    return a.line;
}

export interface Region<T> {
    readonly line: number;
    readonly value: T;
}

export interface ReadonlyRegionMap<T> {
    findRegion(sourceFile: SourceFile, line: number): Region<T> | undefined;
    regions(sourceFile: SourceFile, line: number): IterableIterator<Region<T>>;
}

export class RegionMap<T> implements ReadonlyRegionMap<T> {
    private _sourceFileRegions?: Map<string, SortedUniqueList<Region<T>>>;
    private _equateRegions: (a: Region<T>, b: Region<T>) => boolean;

    constructor(equateValues: (a: T, b: T) => boolean) {
        this._equateRegions = (a, b) => a.line === b.line && equateValues(a.value, b.value);
    }

    /**
     * Adds a `Region` for a source file.
     * @param sourceFile The source file in which to add a region
     * @param line The line number of the region start
     * @param value The value for the region
     */
    addRegion(sourceFile: SourceFile, line: number, value: T) {
        this._sourceFileRegions ??= new Map();
        let regions = this._sourceFileRegions.get(sourceFile.filename);
        if (!regions) this._sourceFileRegions.set(sourceFile.filename, regions = new SortedUniqueList(compareRegions, this._equateRegions));
        regions.push({ line, value });
    }

    /**
     * Finds the nearest `Region` that starts at or prior to the provided `line`.
     * @param sourceFile The source file in which to find a region.
     * @param line The line number from which to start searching.
     */
    findRegion(sourceFile: SourceFile, line: number) {
        const regions = this._sourceFileRegions?.get(sourceFile.filename)?.toArray();
        if (!regions) return;
        let index = binarySearchBy(regions, line, selectLine, compareNumbers);
        if (index < 0) index = ~index - 1;
        if (index >= 0 && index < regions.length) return regions[index];
    }

    /**
     * Yields each `Region` that starts at or prior to the provided `line`, starting with the nearest `Region` first.
     * @param sourceFile The source file in which to find a region.
     * @param line The line number from which to start searching.
     */
    * regions(sourceFile: SourceFile, line: number) {
        const regions = this._sourceFileRegions?.get(sourceFile.filename)?.toArray();
        if (!regions) return;
        let index = binarySearchBy(regions, line, selectLine, compareNumbers);
        if (index < 0) index = ~index - 1;
        while (index >= 0 && index < regions.length) {
            yield regions[index];
            index--;
        }
    }

    copyFrom(other: RegionMap<T>) {
        if (other._sourceFileRegions) {
            this._sourceFileRegions ||= new Map();
            for (const [filename, regions] of other._sourceFileRegions) {
                this._sourceFileRegions.set(filename, regions.clone());
            }
        }
    }
}