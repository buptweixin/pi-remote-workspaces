# Third-party notices

Pi Remote's original code is covered by the root [MIT License](LICENSE).
Third-party components retain their own licenses. This notice describes the
current source tree and distribution artifacts (`npm` package and PI-Desktop
`.piplug` package); review it when dependencies or distribution formats change.

## Pi SSH extension example

The tool delegation and lifecycle patterns in `src/tools.ts` and
`src/extension.ts` were informed by pi's SSH extension example:

- Source: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/ssh.ts
- Upstream license: https://github.com/earendil-works/pi/blob/main/LICENSE
- License: MIT
- Copyright: 2025 Mario Zechner

The upstream notice is retained below for the referenced implementation patterns.

```text
MIT License

Copyright (c) 2025 Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Design reference and compatibility hosts

- [dsh-remote](https://github.com/flymysql/dsh-remote) is the interaction-design
  reference. No dsh-remote source code or assets are included in this repository.
  Its [upstream license](https://github.com/flymysql/dsh-remote/blob/main/LICENSE)
  is MIT.
- [pi-web](https://github.com/agegr/pi-web) is a compatibility host and is downloaded
  separately for optional integration tests. Its code and assets are not bundled
  with Pi Remote. Its
  [upstream license](https://github.com/agegr/pi-web/blob/main/LICENSE) is MIT.
- [PI-Desktop](https://github.com/vastsa/PI-Desktop) is a compatibility desktop
  host. No PI-Desktop source code or assets are bundled with Pi Remote.
- `@earendil-works/pi-coding-agent` and `typebox` are host-provided optional peer
  dependencies and development dependencies, not bundled copies. Their tested
  versions, `1.5.2` and `1.3.27`, declare MIT licenses. Preserve their own notices
  if you redistribute the host or those packages.

These acknowledgments do not imply endorsement or affiliation.

## Runtime dependencies

Neither the published npm package nor the packaged `.piplug` artifact bundles or
declares third-party runtime dependencies (`dependencies` is empty). Cross-process
file locking and store-only `.piplug` archive packaging use Node.js built-in APIs.
Development-only packages in `package-lock.json` are not distributed in release
artifacts.
