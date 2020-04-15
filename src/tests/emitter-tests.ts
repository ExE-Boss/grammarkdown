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

import { assert } from "chai";
import { CancelToken } from "@esfx/async-canceltoken";
import { Grammar } from "../grammar";
import { CoreAsyncHost } from "../host";

describe("Emitter", () => {
    it("cancelable", async () => {
        const cts = CancelToken.source();
        const grammar = new Grammar(["cancelable.grammar"], {}, CoreAsyncHost.from({
            resolveFile: file => file,
            async readFile(file: string) { return ""; },
            async writeFile(file: string, content: string) { }
        }));
        await grammar.check(/*sourceFile*/ undefined, cts.token);
        cts.cancel();
        try {
            await grammar.emit(/*sourceFile*/ undefined, /*writeFile*/ undefined, cts.token);
            assert.fail("Expected grammar.emit() to throw an error.");
        }
        catch (e) {
        }
    });
});