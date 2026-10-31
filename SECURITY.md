# Security Policy

## Supported versions

Security fixes go to the latest stable release. Pre-releases and older versions are not supported.

## Security maintainer

[Clench5676](https://github.com/Clench5676), the project's maintainer, handles all security reports and releases.

## Reporting a vulnerability

Report privately through
[GitHub private vulnerability reporting](https://github.com/Clench5676/BlueArchive-Modding-and-Patching-Tool/security/advisories/new).
Do not open a public issue, discussion or pull request.

Please include:

- Affected version and platform
- Affected component
- Steps to reproduce or a proof of concept
- Expected impact

Reports in English or Chinese are welcome.

## What to expect

BMPT has a single maintainer, so these are targets, not guarantees.

- First response within 7 days
- Assessment within 14 days
- Coordinated fix and disclosure, within 90 days of the report by default
- Credit in the published advisory, unless you prefer otherwise

## Scope

In scope:

- Handling of malformed or malicious mod files
- The local web UI: loopback binding, Host checks and session tokens
- In-app updates: download, verification and installation
- File writes outside the expected game and data folders
- Android file transfer through ADB

Out of scope:

- The game, its servers, anti-cheat and player accounts
- The content of third-party mods
- Issues that already require code execution as the same local user
- Issues in dependencies or the upstream project that BMPT does not expose; report these to their maintainers

If a dependency issue is reachable through BMPT, report it here as well.

## Testing rules

Test only on your own machines and your own installs. Do not access game servers, other people's accounts or systems,
or anyone else's data.

## Known limitations

- Release builds are not signed with a verified publisher identity.
- The `.md5` files detect corrupted downloads. They do not prove who published a build.
