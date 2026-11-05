# Security policy

Fieldwork is prerelease software that runs model calls, local agent state, optional bridge credentials,
and an authenticated loopback browser room. Security reports are welcome, including reports about a
default-deny boundary that can be bypassed, credentials or private state that can be exposed, or an
external action that can occur without its required authority and durable receipt.

## Supported versions

Only the newest published GitHub prerelease is supported. Older prereleases and untagged development
commits may receive a fix when the same issue affects the newest release, but they do not receive
separate patches.

Fieldwork is maintained as a volunteer prerelease project. No response-time or remediation-time service
level is promised. Reports are reviewed as maintainer capacity permits, and any response will stay in the
private GitHub advisory thread until coordinated disclosure is appropriate.

## Report a vulnerability privately

Use the repository's
[private vulnerability-reporting form](https://github.com/4thkira/fieldworkharness/security/advisories/new).
Do not open a public issue for a vulnerability that has not been coordinated with the maintainer.

Include, when possible:

- the affected release or exact commit;
- the boundary or guarantee that can be bypassed;
- minimal reproduction steps using synthetic data;
- the impact and which local or external authority is required; and
- whether the issue is already public.

Never include a real API key, bridge token, room bearer, private transcript, agent home, or another
person's data. Replace secrets and identifying material with synthetic values that preserve only the
shape needed to reproduce the problem.

The project does not promise a bug bounty. A report may be declined when it concerns only a model or
third-party service outside Fieldwork's boundary, requires a person to run untrusted local code with
their own operating-system authority, or does not affect a supported release. If Fieldwork can make such
a dependency or deployment boundary clearer or safer, documentation and defense-in-depth reports are
still useful.

## Disclosure

Please keep a report private until the maintainer and reporter have agreed that disclosure is safe.
When a fix is released, the advisory should identify the affected and fixed versions without publishing
private test data or credentials.
