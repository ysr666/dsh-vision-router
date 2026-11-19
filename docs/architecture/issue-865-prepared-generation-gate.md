# Issue #865: prepared-call generation safety gate

The official pinned DSH `LlmRuntime.prepareCall()` explicitly binds an adapter
registration before header assembly and dispatch. Its public `llm/stream`
waterfall executes before `adapterStream(options, prepared)`, but does not
expose that private registration. The current DVR twin shortcut checks the
current registry and could therefore select a replacement after preparation.

The real-Host wire fixture now has a baseline positive control and a
candidate test with identical model/provider identifiers across a replacement.
A successful prepared stream must dispatch the old adapter in both cases.
This is a hard acceptance assertion, not an expected-failure workaround.
Until that assertion passes, do not treat the previous C wire/CI success as
complete lifecycle qualification. If it fails, a safe solution must preserve
Host registration binding, not introspect inaccessible preparation state
or arbitrarily weaken the Host contract. No paid model call is involved.

## Candidate correction

The waterfall now delegates to Host next(), scopes pre-projection inputs to the
actual generated twin body, and restores only messages/tools/toolHistory while
retaining Host-resolved controls. The image fallback facade restores once
before either attempt and keeps its prepared stream routed through the facade.
The source adapter still goes through the normal Host runtime. The hard
prepared-generation and exact wire assertions remain mandatory; check the new
commit's results before promotion. Cross-plugin middleware interaction remains
an explicit qualification boundary (not an assertion of universal transparency).
