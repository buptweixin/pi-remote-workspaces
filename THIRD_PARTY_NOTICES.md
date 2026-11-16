# Third-party notices

Pi Remote's original code is covered by the root [MIT License](LICENSE).
Third-party components retain their own licenses. This notice describes the
current `0.1.1` source tree and locked runtime dependencies; review it when
dependencies or distribution formats change.

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

## Design reference and compatibility host

- [dsh-remote](https://github.com/flymysql/dsh-remote) is the interaction-design
  reference. No dsh-remote source code or assets are included in this repository.
  Its [upstream license](https://github.com/flymysql/dsh-remote/blob/main/LICENSE)
  is MIT.
- [pi-web](https://github.com/agegr/pi-web) is a compatibility host and is downloaded
  separately for optional integration tests. Its code and assets are not bundled
  with Pi Remote. Its
  [upstream license](https://github.com/agegr/pi-web/blob/main/LICENSE) is MIT.
- `@earendil-works/pi-coding-agent` and `typebox` are host-provided peer dependencies
  and development dependencies, not bundled copies. Their tested versions,
  `1.5.2` and `1.3.27`, declare MIT licenses. Preserve their own notices if you
  redistribute the host or those packages.

These acknowledgments do not imply endorsement or affiliation.

## Locked runtime dependencies

The ordinary npm artifact compiles this project's TypeScript without bundling
dependency source. npm installs the following packages separately, including their
own license files. The notices below are retained here as well.

| Package | Locked version | License | Upstream |
| --- | --- | --- | --- |
| proper-lockfile | 4.1.2 | MIT | https://github.com/moxystudio/node-proper-lockfile |
| graceful-fs | 4.2.12 | BlueOak-1.0.0 | https://github.com/isaacs/node-graceful-fs |
| retry | 0.12.0 | MIT | https://github.com/tim-kos/node-retry |
| signal-exit | 3.0.7 | ISC | https://github.com/tapjs/signal-exit |

The lockfile also contains development and platform-specific packages that are
not included in this list. It is not a complete notice inventory for a separately
bundled application, Docker image, or redistribution of `node_modules`.


### proper-lockfile 4.1.2 — MIT

```text
The MIT License (MIT)

Copyright (c) 2018 Made With MOXY Lda <hello@moxy.studio>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

### graceful-fs 4.2.12 — BlueOak-1.0.0

```text
# Blue Oak Model License

Version 1.0.0

## Purpose

This license gives everyone as much permission to work with
this software as possible, while protecting contributors
from liability.

## Acceptance

In order to receive this license, you must agree to its
rules.  The rules of this license are both obligations
under that agreement and conditions to your license.
You must not do anything with this software that triggers
a rule that you cannot or will not follow.

## Copyright

Each contributor licenses you to do everything with this
software that would otherwise infringe that contributor's
copyright in it.

## Notices

You must ensure that everyone who gets a copy of
any part of this software from you, with or without
changes, also gets the text of this license or a link to
<https://blueoakcouncil.org/license/1.0.0>.

## Excuse

If anyone notifies you in writing that you have not
complied with [Notices](#notices), you can keep your
license by taking all practical steps to comply within 30
days after the notice.  If you do not do so, your license
ends immediately.

## Patent

Each contributor licenses you to do everything with this
software that would otherwise infringe any patent claims
they can license or become able to license.

## Reliability

No contributor can revoke this license.

## No Liability

***As far as the law allows, this software comes as is,
without any warranty or condition, and no contributor
will be liable to anyone for any damages related to this
software or this license, under any kind of legal claim.***
```

### retry 0.12.0 — MIT

```text
Copyright (c) 2011:
Tim Koschützki (tim@debuggable.com)
Felix Geisendörfer (felix@debuggable.com)

 Permission is hereby granted, free of charge, to any person obtaining a copy
 of this software and associated documentation files (the "Software"), to deal
 in the Software without restriction, including without limitation the rights
 to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 copies of the Software, and to permit persons to whom the Software is
 furnished to do so, subject to the following conditions:

 The above copyright notice and this permission notice shall be included in
 all copies or substantial portions of the Software.

 THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 THE SOFTWARE.
```

### signal-exit 3.0.7 — ISC

```text
The ISC License

Copyright (c) 2015, Contributors

Permission to use, copy, modify, and/or distribute this software
for any purpose with or without fee is hereby granted, provided
that the above copyright notice and this permission notice
appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES
OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE
LIABLE FOR ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES
OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS,
WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION,
ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```
