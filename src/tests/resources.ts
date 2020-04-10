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

import { readdirSync, statSync, existsSync, readFileSync } from "fs";
import { resolve, extname, posix } from "path";
import { Host, HostOptions } from "../host";
import { Cancelable } from "@esfx/cancelable";

let grammarFiles: TestFile[];

export interface TestFile {
    readonly basename: string;
    readonly path: string;
    readonly relative: string;
    readonly content: string;
    readonly options: Readonly<Record<string, string>>;
}

export class TestFileHost extends Host {
    private file: TestFile;

    constructor(file: TestFile, options?: HostOptions) {
        super(options);
        this.file = file;
    }

    isTestFile(file: string) {
        return file === this.file.path || file === this.file.relative;
    }

    normalizeFile(file: string) {
        return this.isTestFile(file) ? file : super.normalizeFile(file);
    }

    resolveFile(file: string, referer?: string) {
        if (referer === this.file.relative) referer = this.file.path;
        return this.isTestFile(file) ? file : super.resolveFile(file, referer);
    }

    async readFile(file: string, cancelable?: Cancelable) {
        return this.isTestFile(file) ? this.file.content : super.readFile(file, cancelable);
    }

    readFileSync(file: string, cancelable?: Cancelable) {
        return this.isTestFile(file) ? this.file.content : super.readFileSync(file, cancelable);
    }
}

export function getGrammarFiles(): ReadonlyArray<TestFile> {
    if (!grammarFiles) {
        grammarFiles = [];
        collectFilesInPath("../../src/tests/resources", "", grammarFiles);
    }
    return grammarFiles;
}

const nonOptionLineRegExp = /(^|\r?\n)(?!\/\/\s*@)/;

function getOffsetToFirstNonOptionLine(text: string) {
    const match = nonOptionLineRegExp.exec(text);
    return match ? match.index + match[1].length : text.length;
}

const optionLineRegExp = /^\/\/\s*@\s*(\w+)\s*:\s*(.*?)\s*$/gm;

function parseTestFile(content: string) {
    const offset = getOffsetToFirstNonOptionLine(content);
    const optionContent = content.slice(0, offset);
    const options: Record<string, string> = {};
    for (let match = optionLineRegExp.exec(optionContent); match; match = optionLineRegExp.exec(optionContent)) {
        options[match[1]] = match[2];
    }
    const nonOptionContent = content.slice(offset);
    return { options, content: nonOptionContent };
}

function collectFilesInPath(path: string, relative: string, output: TestFile[]) {
    path = resolve(__dirname, path);
    if (existsSync(path)) {
        for (let file of readdirSync(path)) {
            const filePath = resolve(path, file);
            const fileRelative = relative ? posix.join(relative, file) : file;
            const stats = statSync(filePath);
            if (stats.isFile()) {
                if (extname(file) === ".grammar") {
                    const { options, content } = parseTestFile(readFileSync(filePath, "utf8"));
                    output.push({ basename: file, path: filePath, relative: fileRelative, content, options });
                }
            }
            else if (stats.isDirectory()) {
                collectFilesInPath(filePath, fileRelative, output);
            }
        }
    }
}