# Computer use with Cua Driver

Panel integrates the unmodified official **Cua Driver 0.30.4** release through
MCP. The release was checked on 2026-09-29. Its plain semantic version is stable;
GitHub marks releases in this monorepo as prereleases to avoid moving the
repository-wide “Latest” pointer between products. Nightly builds are excluded.

## Runtime setup

From the `panel` project, run:

```sh
npm run setup:cua
```

The setup script downloads a tag-pinned GitHub release asset, checks its exact
size and SHA256, extracts it under `.panel/cua-driver/0.30.4/`, and verifies the
official app signature on macOS. It does not run the remote installer, modify
the shell, install an auto-start service, launch desktop control, or request
system permissions. The script supports universal macOS and Linux x64/arm64
assets. Panel's Windows daemon supervision is not implemented yet.

`PANEL_CUA_DRIVER_PATH` may point at an absolute `CuaDriver.app` or executable
path. On macOS the executable must remain inside the official signed app bundle
so LaunchServices can preserve its privacy identity. Custom overrides are
operator-managed; the release manifest verifies only the project-downloaded
runtime. Re-run setup after changing the pinned version and hashes together in
`scripts/cua-release.json`.

`desktop:bundle` includes the staged runtime, its release provenance, and its
license files. If setup has not run, packaging prints a warning and Panel reports
the runtime as missing. Runtime startup never downloads executable code.

## Permissions and cursor

Use Panel's explicit permission setup action to request Accessibility and Screen
Recording. macOS remains responsible for granting these permissions. macOS Tahoe
may show a separate direct-capture consent dialog. Merely reading CUA status
does not start the driver or prompt for permission.

The driver daemon runs from its signed app via LaunchServices, with a private
socket and PID file. Normal startup skips the first-launch permission prompt
gate; the UI setup route launches the signed permission helper explicitly. The
public `permissions grant` CLI hardcodes `/Applications/CuaDriver.app`, so Panel
uses the exact `__permissions-host-request` helper protocol from the pinned
0.30.4 source for its bundled app. This coupling must be checked when upgrading.
After a grant, Panel restarts its private driver on the next operation so cached
permission denials do not survive.

Panel cancels and awaits its permission-request subprocess during shutdown.
LaunchServices owns the short-lived signed permission helper separately from
the `open -W` subprocess; an already displayed macOS consent dialog can still
require user dismissal after Panel closes. Panel does not auto-approve or
attempt to manipulate that system dialog.

Cursor overlays are enabled. Each native run starts a distinct driver lifecycle
session and enables its session cursor. No `--no-overlay` flag is used. Telemetry
and automatic driver update checks are disabled for Panel-owned processes.

## Tool arguments and approval

Call `computer_use_tools` before using a group. It returns complete **Panel call
schemas**, including the `tool`, `target`, and `arguments` envelope. These are
the arguments to `computer_use_call`; do not nest that envelope inside
`arguments` again. For example, first discover windows with:

```json
{ "tool": "list_windows", "arguments": { "pid": 123 } }
```

Then observe a window ID returned by that discovery:

```json
{
  "tool": "get_window_state",
  "target": { "kind": "window", "pid": 123, "windowId": 456 },
  "arguments": { "query": "search", "max_elements": 200 }
}
```

The IDs above are illustrative; actual calls must use live discovered IDs.
Panel supplies driver session and routing fields. Native `pid/window_id` and
browser `target_id/tab_id` must not be copied into `arguments` (the
`list_windows` PID filter is an exception). Input errors are rejected before
target acquisition and approval, with the offending parameter and a correction
hint. Valid calls follow the approval policy below, and their final routed
arguments are checked again against the official driver schema before dispatch.

### CUA takeover

During an active card run, the user can enable **CUA 接管** beside the right-hand
computer-control heading. This grants that run a narrowly scoped exemption from
repeated safety-model review. It is off by default, applies only to the selected
card's current run, and can be turned off immediately. It is not inherited by
other cards, retries, imports, or subsequent runs, and does not survive a server
restart. A review or approval already in progress keeps its existing decision
flow; enabling takeover does not approve a pending operation retroactively.
Turning it off prevents further takeover dispatches; a single operation already
started by the CUA adapter may finish, including waiting for its operation permit.
Use the card's stop action to interrupt the current run.

**基础查看** keeps the conservative deterministic allowlist: tool-schema discovery and release, application
and window listing, read-only diagnostics, window/page observations and
screenshots, background native scrolling, and browser-pointer hover/scroll.
The pinned driver's `zoom` operation crops a screenshot, so it is included.
Its `browser_pointer` has no `move` action; hovering is the supported pointer
movement. Browser hover/scroll accept the documented `trusted` or `dom_event`
route with the exact targeting arguments required by that route.

In **基础查看**, clicks, double/right clicks, dragging, typing, key presses,
navigation, dialogs, application launch, browser preparation and window changes
still follow normal review. Explicit foreground native scrolling also keeps review because it
temporarily fronts the target window. Unknown operations, modes and parameters
never acquire an exemption merely by having an observation-like name or a
model-provided low-risk claim. The policy is pinned to known 0.30.4 argument
shapes and must be reviewed when the driver adds capabilities.

**本任务控制** is available after an approved observation has identified a live
window or browser page. The user selects it in the right-side takeover mode
control. The UI displays the exact target and, for browser pages, the HTTP(S)
origin. This is a separate explicit grant, bound to that card/run and adapter
session generation. Another window, tab, scheme, host or port is outside it;
choosing “改为授权当前目标” replaces the old grant instead of accumulating access.
Scope choices come from live driver results, never model arguments, imported
state, or URL/title text parsed from an assistant response.

Within that scope, the adapter uses the pinned driver's actual structured
observations to recognize search fields, search/pagination buttons, and ordinary
same-origin links. Search input is single-line and element-addressed. Browser
semantic_v2 provides typed roles; dom_refs_v1 provides link hrefs. The latter
flattens attributes into text, so only an unambiguous sole href (optionally with
role=link) qualifies. Unknown or ambiguous labels, iframe content, generic text
fields, coordinates, shortcuts, foreground actions, and other mutations retain
normal review. Navigation qualifies only for a currently observed same-origin
link, with known consequential/download/redirect paths excluded. These are
conservative UI heuristics, not proof of a site's server-side effects: task
control grants routine interaction with the selected site, not a browser sandbox.

The adapter re-observes under the existing operation lock immediately before a
scoped mutation, checks the origin/session again, and remaps an element ref only
when exactly one unchanged semantic target remains. It re-applies the policy to
the fresh result and rechecks that the user grant is still active. Redirected
pages, replaced or ambiguous controls and revocation stop dispatch. A later
explicit observation exposes the new scope for a new user grant; it is never
automatically added. The extra observation is a driver call, not a safety-model
request. Routine permitted operations therefore skip both manual approval and
per-action model review. Recognized send/pay/delete/permission controls and
confirmation-dialog resolution require a human checkpoint even in automatic
review mode. Unknown actions keep the normal configured approval route. No
approval of one unknown action creates a blanket rule for future actions.

Takeover is evaluated after ordinary CUA preflight and does not bypass schema
validation, target ownership, observation requirements, cancellation, or the
driver's final schema checks. Window/page leases and foreground coordination
remain in force, including between parallel cards. Observation still sends the
selected window/page's content and screenshot to the current model.

## Lifetimes and concurrency

One Panel host owns one daemon. Native runs have independent MCP transports and
driver session labels. Closing a run ends its session, and daemon-side transport
EOF cleanup is an additional safeguard. A temporary stdin lease stops Panel's
private daemon if the host crashes; it is not a persistent background service.
Panel closes the daemon during orderly server shutdown.

Driver sessions do not create independent desktops. Cua serializes native input
delivery internally, but Panel must still hold its own target leases around
multi-step work. The driver client deliberately does not choose lock granularity;
the Panel computer-use coordinator owns window and browser-page scheduling.
Foreground input and shared desktop resources need global coordination even
when the target windows differ.

Browser target and tab IDs returned by Cua are session-scoped capabilities.
Titles and URLs cannot establish that two sessions refer to the same physical
tab. Panel therefore uses a common browser session and central binding registry
to coordinate exact page identities. Reconnect changes the session's
`generation`; all cached bindings and references from an older generation must
be discarded. Native operations still use per-run sessions.

Cancellation before dispatch does not send a native action. After dispatch,
Panel waits for the action's result before releasing its scheduling permit;
rejecting a local MCP promise alone would not prove the action has stopped. An
unknown transport outcome or request timeout stops the owned daemon and
invalidates its MCP connections before settling the request. Actions are never
replayed automatically. Stopping a run can therefore wait for an in-flight
operation to finish, up to its timeout.

The daemon runs in Cua's `standard` permission mode. Panel does not pass
`--grant existing-profile` or enable unrestricted mode. Existing-profile browser
CDP setup can therefore be refused by the official driver; native window control
and authorized isolated-browser paths are separate capabilities.

## Upstream references

- [Pinned release and checksums](https://github.com/trycua/cua/releases/tag/cua-driver-rs-v0.30.4)
- [Process and session model](https://github.com/trycua/cua/blob/cua-driver-rs-v0.30.4/docs/content/docs/reference/cua-driver/process-model.mdx)
- [macOS permission ownership](https://github.com/trycua/cua/blob/cua-driver-rs-v0.30.4/docs/content/docs/reference/cua-driver/macos-permissions.mdx)
- [MCP tools and argument contract](https://github.com/trycua/cua/blob/cua-driver-rs-v0.30.4/docs/content/docs/reference/cua-driver/mcp-tools.mdx)
- [Browser capability binding](https://github.com/trycua/cua/blob/cua-driver-rs-v0.30.4/libs/cua-driver/rust/crates/cua-driver-core/src/browser/tools.rs)
- [LaunchServices permission helper](https://github.com/trycua/cua/blob/cua-driver-rs-v0.30.4/libs/cua-driver/rust/crates/cua-driver/src/cli.rs)

The community `@amaster.ai/pi-computer-use` extension informed the architecture
(MCP tool discovery, managed driver lifetime, image preservation, and process
leases). Panel does not vendor that extension or patch the official driver.
