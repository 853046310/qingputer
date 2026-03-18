# Runtime API Contract

All authenticated requests must include:

```text
Authorization: Bearer <runtime-token>
```

## REST endpoints

### `POST /api/sessions`

Creates a new authorized session.

```json
{
  "config": {
    "cwd": "/Users/alice",
    "grants": {
      "terminal": true,
      "filesystem": true,
      "browser": true
    },
    "approval_mode": "session_once_plus_high_risk",
    "idle_timeout_minutes": 60,
    "absolute_timeout_hours": 8
  }
}
```

### `GET /api/sessions/:id`

Returns the current `SessionRecord`.

### `POST /api/sessions/:id/messages`

Adds a user message and triggers the agent loop.

```json
{
  "content": "Open example.com and summarize the page."
}
```

### `POST /api/sessions/:id/approvals/:approval_id/approve`

Approves the pending action, executes it, and resumes the agent loop.

### `POST /api/sessions/:id/approvals/:approval_id/deny`

Denies the pending action and resumes the agent loop with a denial tool result.

### `GET /api/sessions/:id/history`

Returns:

- `session`
- `messages`
- `approvals`
- `events`

### `GET /api/settings`

Returns model configuration and whether an OpenAI API key exists in Keychain.

### `PUT /api/settings`

Updates the model and/or stores an API key in Keychain.

```json
{
  "openai_model": "gpt-4.1",
  "openai_api_key": "sk-..."
}
```

### `DELETE /api/settings/openai-key`

Deletes the stored OpenAI API key from Keychain.

### `POST /api/settings/browser-profile/reset`

Deletes the isolated Chromium profile directory and recreates it.

## WebSocket

### `WS /api/sessions/:id/events?token=<runtime-token>`

Streams event envelopes:

```json
{
  "event_id": "evt_123",
  "session_id": "session_123",
  "kind": "command_output",
  "payload": {
    "chunk": "hello\n"
  },
  "created_at": "2026-01-01T00:00:00Z"
}
```
