# Example configurations

Copy one of these files to `~/.pi/agent/extensions/rail.json` for a global
profile or to `.pi/rail.json` in a trusted project.

Configuration is layered over Pi Rail's defaults. Omitted fields retain their
default values; arrays are replaced wholesale when present.

- `classifier-focused.json` disables filesystem and network restrictions and
  environment scrubbing, leaving tool actions to classifier review and command
  rules. The Seatbelt backend still wraps shell processes.
- `balanced.json` keeps the default filesystem and network restrictions and
  adds fail-closed classifier review.
- `offline-restricted.json` permits writes only in the project and temporary
  directory, blocks all networking, retains sensitive-path denies, and adds
  fail-closed classifier review.
- `network-allowlist.json` disables filesystem restrictions and permits network
  access only to the listed domains. It is the explicit allowlist-only example.
- `filesystem-denylist.json` disables network restrictions and otherwise allows
  filesystem access except for the listed sensitive paths. It is the explicit
  denylist-driven example; `allowWrite: ["/"]` supplies the sandbox runtime's
  broad writable root, while `denyWrite` carves sensitive paths back out.
- `dispositions-deny-by-default.json` disables file/network restrictions and
  environment scrubbing, then routes every capability class to `deny` except
  reading the project and running its dev tools. It is the strict
  deny-by-default disposition profile.
- `dispositions-allow-by-default.json` also leans entirely on the disposition
  table, but allows ordinary local coding work and denies a concrete set of
  dangerous classes: credentials, local destruction, persistence, system
  modification, and off-machine effects.

`network.enabled` means “enforce network restrictions.” With it set to `false`,
networking is unrestricted. To deny all networking, set it to `true` with an
empty `allowedDomains` array and `deniedDomains: ["*"]`.

The sandbox runtime's domain policy is allowlist-based, so a network
denylist-only policy is not supported. Its write policy also requires at least
one writable root; use `"/"` as that root only when you intentionally want the
denylist-driven behavior shown in `filesystem-denylist.json`.

The two `dispositions-*.json` profiles intentionally remove deterministic
file/network boundaries. Their policy is the capability disposition table: a
model names each action with capability classes and the table decides. Treat
them as semantic review policy, not a hard sandbox.
