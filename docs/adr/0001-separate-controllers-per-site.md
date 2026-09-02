# Separate controllers per playtest site

MoxPod needs to manipulate game state on multiple playtest sites (Moxfield,
Archidekt, and potentially others). Each site uses a fundamentally different
state management approach — Moxfield uses a React class component with
`setState` and a monkeypatched `handleSaveData`; Archidekt uses a Redux store
with `store.subscribe` and `store.dispatch`. We chose to write a separate
controller per site rather than abstracting the existing PlaytestController
behind a pluggable backend.

The controllers share a common interface (same event types, same
read/write/mutation methods) but each implementation is fully independent.
`content-main.js` detects the current site and delegates to the appropriate
controller.

## Considered Options

- **Abstract PlaytestController with pluggable backend**: Would keep a single
  controller class with swappable internals for state access, mutation, and
  change detection. Rejected because the Moxfield controller's internals
  (mutation queue via `setState` callbacks, `handleSaveData` monkeypatch,
  `state.zones` structure) are so deeply shaped by React class component
  patterns that abstracting them would be more work than a clean rewrite, and
  the abstraction would leak site-specific details.

- **Separate content-main.js per site**: Would avoid any shared code in the
  MAIN world. Rejected because the postMessage bridge, `withSync` depth
  counter, command dispatch, and event forwarding are genuinely shared logic
  that shouldn't be duplicated.
