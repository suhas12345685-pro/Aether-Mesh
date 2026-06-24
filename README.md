# Aether Mesh

Aether Mesh is an autonomous digital worker that joins your team's existing
communication channels (Slack, Teams, WhatsApp, email, SMS), detects
outstanding tasks from conversation history, completes them, and posts the
finished deliverable back — without being prompted.

**Key properties:**
- **Bring Your Own Brain (BYOB):** connect any OpenAI-compatible API or a local model. Your data never leaves your infrastructure.
- **Persistent heartbeat loop:** proactive, not reactive. No human needs to type a prompt.
- **Self-correcting:** critiques its own output before it reaches humans.
- **Skill injection:** acquires missing tool plugins from a registry at runtime.

## Repository layout

| Directory | Contents |
| :--- | :--- |
| `aether/` | The product layer — heartbeat core, infra, platform, supervisor, website |
| `hermes-agent/` | AI agent runtime (the brain Aether drives) |
| `openclaw/` | Multi-channel gateway fabric (Slack, Teams, WhatsApp, email, SMS) |

For full architecture, security model, and deployment instructions see
[`aether/README.md`](aether/README.md).
