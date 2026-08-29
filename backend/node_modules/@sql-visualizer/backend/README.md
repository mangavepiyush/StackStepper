# Backend Package

The backend owns trace ingestion, session persistence, replay APIs, and WebSocket streaming.

Planned responsibilities:

- Receive events from the collector
- Validate schema version
- Order and persist execution traces
- Expose live and replay endpoints
- Support filtering by execution, subsystem, table, transaction, and event type

Suggested implementation:

- TypeScript
- Fastify
- WebSocket
- SQLite or PostgreSQL for metadata
- NDJSON or columnar trace storage for event bodies
