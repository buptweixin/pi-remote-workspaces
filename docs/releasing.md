# Releasing Pi Remote

- Package: `@arnowei/pi-remote-workspaces`
- npm owner: `arnowei`
- Repository: [buptweixin/pi-remote-workspaces](https://github.com/buptweixin/pi-remote-workspaces)
- Author: Arno Wei
- Workflow: [publish.yml](../.github/workflows/publish.yml)

## First publication

Use Node.js 22.19 or later. Log in to npm on your own device and complete the
registry's email and two-factor authentication requirements:

```sh
npm login --registry=https://registry.npmjs.org/
npm whoami --registry=https://registry.npmjs.org/
```

The expected username is `arnowei`. Keep credentials and local `.npmrc` files out
of Git and release archives.

Run the checks and inspect the real archive:

```sh
npm ci
npm run check
npm test
npm run test:integration
npm run test:pi-web
npm run test:package -- --output-dir release-artifacts
```

The package check installs the tarball with production dependencies only, starts
both CLI entry points, and loads the extension through pi's resource loader.
`release-artifacts/` is ignored by Git and excluded from the npm package.

For the initial `0.1.0` release, publish the verified archive:

```sh
npm publish ./release-artifacts/arnowei-pi-remote-workspaces-0.1.0.tgz --access public
npm view @arnowei/pi-remote-workspaces@0.1.0 name version dist.integrity --json
```

Finish any authentication challenge through npm's browser flow. Never put a
password or OTP into a commit, workflow, or support message.

## Configure npm Trusted Publishing

The package must exist before configuring its trusted publisher. With npm 11.15
or later, an authenticated account, and account-level 2FA enabled, run:

```sh
npm trust github @arnowei/pi-remote-workspaces --repo buptweixin/pi-remote-workspaces --file publish.yml --allow-publish --yes
npm trust list @arnowei/pi-remote-workspaces
```

Alternatively, open the package settings on npm and configure:

| Field | Value |
| --- | --- |
| Provider | GitHub Actions |
| Organization or user | `buptweixin` |
| Repository | `pi-remote-workspaces` |
| Workflow filename | `publish.yml` |
| Environment | Leave blank |
| Allowed action | Direct publication with `npm publish` |

The workflow uses GitHub-hosted runners and `id-token: write`. It does not require
an `NPM_TOKEN` secret. npm generates provenance for eligible public OIDC releases.
Complete the first successful publish through a newly configured publisher within
the validity window documented by npm; an expired, unvalidated configuration must
be recreated.

See [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/) and
[`npm trust`](https://docs.npmjs.com/cli/v11/commands/npm-trust/).

## Later releases

1. Update `CHANGELOG.md` with a `## X.Y.Z - YYYY-MM-DD` heading.
2. Update `package.json` and `package-lock.json` to the same stable version.
3. Commit the changes and wait for CI on `main` to pass.
4. Create and push the matching version tag. For example, for a future `0.1.1`:

```sh
npm version patch --no-git-tag-version
git add package.json package-lock.json CHANGELOG.md
git commit -m "chore: release 0.1.1"
git tag v0.1.1
git push origin main
git push origin v0.1.1
```

The Publish workflow checks the tag against `package.json` and the changelog,
runs tests, verifies a production installation of the exact tarball, and publishes
that archive through OIDC. It then checks public npm metadata and creates a GitHub
release with the tarball attached. A version already present on npm is not
published again. Only stable `vX.Y.Z` tags are supported by this workflow.

To retry an existing release tag, use **Actions → Publish → Run workflow**, then
enter the existing tag. This does not increment the version.

## Verify distribution

```sh
pi install npm:@arnowei/pi-remote-workspaces
pi -e npm:@arnowei/pi-remote-workspaces
npx --yes --package @arnowei/pi-remote-workspaces pi-remote --help
```

Use a separate temporary `PI_CODING_AGENT_DIR` for automated installation checks
so they do not change personal pi settings. The `pi-package` keyword makes the
published package eligible for [pi.dev discovery](https://pi.dev/packages);
catalog indexing may take time and is separate from npm publication.
