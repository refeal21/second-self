# Third-party notices

This repository does not copy source code from `slides_maker`, `pptkit-presentation`, or Presenton. Their product and workflow ideas were studied, but no files or snippets from those repositories are included.

The application links, bundles, or uses the following principal third-party components. Transitive dependency notices remain available in the respective package distributions and lockfiles.

| Component | Use | License |
| --- | --- | --- |
| Node.js 22 | Runtime embedded in the Worker single executable | MIT plus the dependency licenses/notices carried in the matching Node distribution `LICENSE` |
| Tauri and Tauri plugins | macOS shell, IPC, bundling and process supervision | Apache-2.0 OR MIT |
| React / React DOM | Desktop WebView UI | MIT |
| PptxGenJS | Editable PPTX generation | MIT |
| pngjs | Deterministic PNG fixtures and image checks | MIT |
| JSZip | Local OOXML template and test inspection | MIT OR GPL-3.0-or-later; used under MIT |
| fast-xml-parser 5.11.1 | Bounded local PPTX palette XML inspection | MIT |
| SQLite / rusqlite | Local state store | SQLite public-domain dedication; rusqlite MIT |
| serde / serde_json | Rust serialization | Apache-2.0 OR MIT |
| Vite, Vitest, TypeScript, tsx, esbuild | Development, testing and build tooling | MIT |
| LibreOffice | External, user-installed QA renderer; not bundled | MPL-2.0 |

The app bundle contains the exact `LICENSE` from the Node executable used to build the SEA, including Node's dependency license and third-party notice sections, at `Contents/Resources/licenses/node-runtime/LICENSE-and-third-party-notices.txt`. Its matching version is recorded beside it in `VERSION.txt`; the build fails instead of packaging an unmatched or incomplete notice.

Upstream license texts:

- Node.js: <https://github.com/nodejs/node/blob/v22.x/LICENSE>
- Tauri: <https://github.com/tauri-apps/tauri/blob/dev/LICENSE_APACHE-2.0> and <https://github.com/tauri-apps/tauri/blob/dev/LICENSE_MIT>
- React: <https://github.com/facebook/react/blob/main/LICENSE>
- PptxGenJS: <https://github.com/gitbrent/PptxGenJS/blob/master/LICENSE>
- pngjs: <https://github.com/pngjs/pngjs/blob/master/LICENSE>
- JSZip: <https://github.com/Stuk/jszip/blob/main/LICENSE.markdown>
- fast-xml-parser: <https://github.com/NaturalIntelligence/fast-xml-parser/blob/master/LICENSE>
- rusqlite: <https://github.com/rusqlite/rusqlite/blob/master/LICENSE>
- serde: <https://github.com/serde-rs/serde/tree/master#license>
- LibreOffice: <https://www.libreoffice.org/about-us/licenses>

## MIT license text

The XML inspection dependency and its bundled MIT-licensed dependency distributions carry these notices (the MIT permission and disclaimer below apply to each):

- fast-xml-parser 5.11.1: Copyright (c) 2017 Amit Kumar Gupta.
- fast-xml-builder 1.3.1, is-unsafe 2.0.2, xml-naming 0.3.0: Copyright (c) 2026 Natural Intelligence.
- strnum 2.4.2: Copyright (c) 2021 Natural Intelligence.
- path-expression-matcher 1.6.2: Copyright (c) 2024 (as supplied in its LICENSE).
- @nodable/entities 3.0.0: Copyright (c) 2026 Nodable. Its package declares MIT; the upstream [val-parsers license](https://github.com/nodable/val-parsers/blob/main/LICENSE) supplies the copyright notice omitted from the npm archive.

Copyright (c) the respective copyright holders.

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## Project code

No open-source license is granted for the original project code by this notice. Add a project-level license only when the repository owner chooses one; third-party licenses above continue to apply independently.
