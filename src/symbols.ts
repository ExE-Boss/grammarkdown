let nextSymbolId = 0;

export enum SymbolKind {
    SourceFile,
    Production,
    Parameter
}

export class Symbol {
    public id: number = ++nextSymbolId;
    public name: string;
    public kind: SymbolKind;
    public parent: Symbol | undefined;
    public locals: SymbolTable | undefined;

    constructor(kind: SymbolKind, name: string) {
        this.kind = kind;
        this.name = name;
    }
}

export class SymbolTable {
    private nameMap: Map<SymbolKind, Map<string, Symbol>> | undefined;

    get isEmpty() { return !this.nameMap; }

    public resolveSymbol(name: string, kind: SymbolKind): Symbol | undefined {
        if (name) {
            const symbols = this.getSymbols(kind, /*create*/ false);
            if (symbols) {
                return symbols.get(name);
            }
        }

        return undefined;
    }

    /* @internal */
    public copyFrom(other: SymbolTable) {
        if (other === this || !other.nameMap) return;
        for (const [kind, otherSymbols] of other.nameMap) {
            if (!this.nameMap) this.nameMap = new Map<SymbolKind, Map<string, Symbol>>();
            let symbols = this.nameMap.get(kind);
            if (!symbols) this.nameMap.set(kind, symbols = new Map<string, Symbol>());
            for (const [name, symbol] of otherSymbols) {
                symbols.set(name, symbol);
            }
        }
    }

    /* @internal */
    public declareSymbol(name: string | undefined, kind: SymbolKind, parent?: Symbol): Symbol {
        let symbol: Symbol | undefined;
        if (name) {
            const symbols = this.getSymbols(kind, /*create*/ true);
            symbol = symbols.get(name);
            if (!symbol) {
                symbol = new Symbol(kind, name);
                symbols.set(name, symbol);
            }
        }
        else {
            symbol = new Symbol(kind, "*missing*");
        }

        symbol.parent = parent;
        return symbol;
    }

    private getSymbols(kind: SymbolKind, create: true): Map<string, Symbol>;
    private getSymbols(kind: SymbolKind, create: boolean): Map<string, Symbol> | undefined;
    private getSymbols(kind: SymbolKind, create: boolean): Map<string, Symbol> | undefined {
        if (!this.nameMap) {
            if (!create) {
                return undefined;
            }

            this.nameMap = new Map<SymbolKind, Map<string, Symbol>>();
        }

        let symbols = this.nameMap.get(kind);
        if (symbols) return symbols;
        if (create) this.nameMap.set(kind, symbols = new Map<string, Symbol>());
        return symbols;
    }
}