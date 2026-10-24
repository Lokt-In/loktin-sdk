# Releasing @loktin/sdk

These are the owner's steps for releasing the SDK to npm. The release workflow is `.github/workflows/release-sdk.yml` (V3, W60, W62).

## 1. One-time setup

1. Turn on two-factor authentication for your npm account.
2. Create the npm organisation `loktin`, and require two-factor authentication for its members.

## 2. First publish of 0.1.0, by hand

A trusted publisher can only be set up for a package that already exists on npm, so the first version is published by hand. Do this after the release pull request is merged.

From an up-to-date `main`:

```sh
nvm use
npm ci
npm run build
npm login
npm publish -w packages/sdk
npm logout
```

`nvm use` switches to the Node 24 named in `.nvmrc`. npm asks you to confirm with two-factor authentication. From the terminal it shows a link: open it in your browser and approve with your security key. `npm logout` removes the login token from this machine, so no long-lived publish token stays behind. The package goes out under the `next` tag. This version has no provenance, because it is not published from CI.

## 3. Tag 0.1.0

The tag gives the version its GitHub release:

```sh
git tag sdk-v0.1.0
git push origin sdk-v0.1.0
```

The workflow sees that 0.1.0 is already on npm, skips staging and creates a draft GitHub release from the changelog. Check the draft on GitHub and publish it.

## 4. Every later release

1. In a pull request, bump the version in `packages/sdk/package.json` and add a `## @loktin/sdk <version>` section to `CHANGELOG.md`. Merge it.
2. Before the first release from CI, set up the trusted publisher for `@loktin/sdk` on npmjs.com:
   - organisation or user: `Lokt-In`;
   - repository: `loktin-sdk`;
   - workflow: `release-sdk.yml`;
   - environment: none;
   - allowed actions: stage publish only.

   A new trusted publisher expires if it is not used within 2 days, so set it up just before you push the tag.

3. Tag the merged commit on `main` and push the tag:

   ```sh
   git tag sdk-v<version>
   git push origin sdk-v<version>
   ```

   The workflow refuses a tag that is not on `main` or does not match the package version. It runs every check, stages the version on npm with provenance, and creates a draft GitHub release.

4. Approve the staged version with two-factor authentication, either with `npm stage approve <stage-id>` or on the Staged Packages tab on npmjs.com. Nothing goes live until you approve it.
5. Publish the draft GitHub release.

## 5. After the first release from CI

Once a release from CI has worked, set the package's publishing access on npmjs.com to "Require two-factor authentication and disallow tokens".

## 6. Tags

A tag is never moved or reused. If a release goes wrong, release a new version with a new tag.
