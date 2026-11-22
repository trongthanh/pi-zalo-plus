# Publishing to npm

The `Publish to npm` workflow publishes when a push to `main` changes the
version in `package.json`. It installs dependencies and runs the package's
`prepublishOnly` checks (tests and typecheck) before publishing. A manual run
from `main` can retry a failed release; npm will reject an already-published
version. Update `package-lock.json` along with the package version.

## One-time npm setup

Before merging a release, a package maintainer must configure an npm trusted
publisher in the [pi-zalo-plus package settings](https://www.npmjs.com/package/pi-zalo-plus/access):

- Provider: GitHub Actions
- Organization or user: `trongthanh`
- Repository: `pi-zalo-plus`
- Workflow filename: `publish.yml`
- Environment: leave blank
- Allow direct `npm publish` if prompted

No npm token or GitHub secret is needed. See the [npm trusted publishing
documentation](https://docs.npmjs.com/trusted-publishers/) for details. If the
first run fails, correct the setup and retry the workflow from the Actions tab.
