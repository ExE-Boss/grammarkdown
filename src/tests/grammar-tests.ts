/*!
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

import { getGrammarFiles, TestFile, TestFileHost } from "./resources";
import { SourceFile } from "../nodes";
import { DiagnosticMessages } from "../diagnostics";
import { Scanner } from "../scanner";
import { writeTokens, compareBaseline, writeNodes, writeDiagnostics, writeOutput } from "./diff";
import { Parser } from "../parser";
import { Grammar } from "../grammar";
import { EmitFormat, NewLineKind } from "../options";

describe("Grammar", () => {
    defineSuites();

    function defineSuites() {
        for (const file of getGrammarFiles()) {
            defineGrammarSuite(file);
        }
    }

    function defineGrammarSuite(file: TestFile) {
        describe(file.relative, () => {
            if (file.options.full === "true") {
                file = {
                    ...file,
                    options: {
                        tokens: "true",
                        nodes: "true",
                        diagnostics: "true",
                        emit: "ecmarkup,html,markdown",
                        ...file.options
                    }
                };
            }
            if (file.options.tokens === "true") defineScannerTest(file);
            if (file.options.nodes === "true") defineParserTest(file);
            if (file.options.diagnostics !== "false") defineCheckerTest(file);
            defineEmitterTests(file);
        });
    }

    function defineScannerTest(file: TestFile) {
        it("tokens", () => {
            const sourceFile = new SourceFile(file.relative, file.content, []);
            const diagnostics = new DiagnosticMessages();
            diagnostics.setSourceFile(sourceFile);
            const scanner = new Scanner(file.relative, file.content, diagnostics);
            compareBaseline(writeTokens(file.relative, scanner, sourceFile.lineMap));
        });
    }

    function defineParserTest(file: TestFile) {
        it("parse tree", () => {
            const parser = new Parser();
            const sourceFile = parser.parseSourceFile(file.relative, file.content);
            compareBaseline(writeNodes(file.relative, sourceFile));
        });
    }

    function defineCheckerTest(file: TestFile) {
        it("diagnostics", async () => {
            const grammar = new Grammar([file.relative], { newLine: NewLineKind.CarriageReturnLineFeed }, new TestFileHost(file));
            await grammar.check(/*sourceFile*/ undefined);
            compareBaseline(writeDiagnostics(file.relative, grammar.diagnostics));
        });
    }

    function defineEmitterTests(file: TestFile) {
        const { emit = "ecmarkup" } = file.options;
        if (emit === "none") return;

        const modes = emit.split(/\s*,\s*|\s+/g);
        for (const mode of modes) {
            defineEmitterTest(file, mode);
        }
    }

    function defineEmitterTest(file: TestFile, mode: string) {
        const format = mode === "html" ? EmitFormat.html : mode === "markdown" ? EmitFormat.markdown : EmitFormat.ecmarkup;
        const extname = mode === "html" ? ".html" : mode === "markdown" ? ".md" : ".emu.html";
        const emitLinks = mode === "html";
        it(`emit ${EmitFormat[format]}`, async () => {
            let output: string | undefined;
            const grammar = new Grammar([file.relative], { format, emitLinks, newLine: NewLineKind.CarriageReturnLineFeed }, new TestFileHost(file));
            await grammar.emit(/*sourceFile*/ undefined, async (_, _output) => { output = _output; });
            compareBaseline(writeOutput(file.relative, extname, output));
        });
    }
});