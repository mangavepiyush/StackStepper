# Frontend Package

The frontend is a replay and inspection surface for real MySQL runtime events.

Planned modules:

- SQL editor
- Timeline and playback controls
- Event detail pane
- Buffer pool viewer
- Page diff viewer
- B+Tree path viewer
- Lock graph
- Transaction and log panels
- Search and filtering

Important rule:

The frontend may derive visual state from events, but it must never invent unobserved execution steps.
