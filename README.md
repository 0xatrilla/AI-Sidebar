# AI Sidebar for Obsidian

AI Sidebar adds a Cursor/VS Code-style assistant panel to Obsidian. It opens from the ribbon or command palette. You can assign a shortcut from Obsidian's hotkeys settings.

The plugin is desktop-only because v1 can talk to local CLI agents such as Codex, Claude Code, and opencode. It also supports OpenAI-compatible API providers and OAuth-capable providers when they publish desktop OAuth endpoints.

## Features

- Right-sidebar AI panel.
- Configurable providers:
  - OpenAI-compatible API key providers.
  - OAuth-capable providers.
  - Local CLI providers.
- Relevant vault context from the active note, selection, links, backlinks, Bases files, and search matches.
- Context preview automatically updates when you open or switch notes.
- Slash commands for provider-native controls and vault-local agent skills.
- Optional conversation memory so the sidebar can remember earlier chats after being closed.
- Three vault access modes:
  - Read only: proposed writes are blocked.
  - Confirm actions: proposed writes are shown before applying.
  - Full access: valid proposed writes are applied directly.

## Privacy and security

AI Sidebar sends the active request and selected vault context to whichever provider you configure. Depending on your provider, that may be a local CLI tool, a local subscription-backed agent, or a remote API endpoint.

The plugin can read notes from your vault to build context. It can also read skill files from `~/.agent/skills/skills` and `~/.agents/skills/skills` so those skills can appear in the slash-command picker.

Vault write actions are controlled by the access mode you choose:

- Read only blocks proposed writes.
- Confirm actions asks before applying proposed writes.
- Full access applies valid proposed writes directly.

The plugin does not include ads or telemetry.

## Development

```bash
npm install
npm run build
```

Copy or symlink this folder into a test vault at:

```text
<vault>/.obsidian/plugins/ai-sidebar
```

If your vault uses a custom configuration folder, replace `.obsidian` with that folder name. Then enable the plugin in Obsidian community plugin settings.

## Provider setup

Open **Settings → AI Sidebar → Connect a Provider** and pick a provider card.

- **Codex**: click **Sign in** to launch the local `codex login` flow.
- **Claude Code**: click **Sign in** to launch the local `claude auth login` flow for Claude subscriptions or Console auth.
- **opencode**: click **Sign in** to launch `opencode auth login`, which can configure keys for providers supported by opencode.
- **Gemini CLI**: click **Sign in** to launch the local Gemini CLI setup.
- **Aider**: click **Sign in** to open Aider's local/provider key setup path.
- **OpenAI API**: click **Get key**, paste an API key, then choose the model you want to use.
- **OpenRouter, DeepSeek, Mistral**: click **Get key**, paste the provider key, and use the prefilled OpenAI-compatible endpoint.

OAuth providers can be added when a provider gives you a desktop app authorization URL, client ID, scope, API endpoint, and access token flow. The plugin can open the login URL and store the returned access token, but provider-specific OAuth details still need to come from that provider.

Local CLI providers are still available. If you use one, set the full command path when Obsidian cannot find the command, for example:

```text
/opt/homebrew/bin/codex
```

## Slash commands

Create skill files in either of these vault folders:

```text
.agent/skills/<skill-name>/SKILL.md
.agents/skills/<skill-name>/SKILL.md
```

Then type `/` in the AI Sidebar prompt to pick a skill. Selected skills are sent to the active provider as `context.selectedSkills`, and the provider is instructed to apply them.

The slash menu also includes provider controls:

```text
/model:gpt-4.1-mini
/reasoning:high
/access:confirm
/memory:off
```

Models come from each provider's comma-separated model list in settings. Reasoning effort is sent for OpenAI-style reasoning models when supported.

## Memory

Conversation memory is enabled by default. The plugin remembers the latest sidebar messages in plugin settings and sends them back to the provider on future requests.

You can turn memory off, change how many messages are remembered, or clear memory in **Settings → AI Sidebar**. The sidebar also has a **Clear** button to wipe the visible conversation and saved memory.

## Local CLI protocol

Local CLI commands receive a prompt argument that includes the user request, instructions, and JSON vault context:

```json
{
  "prompt": "User request",
  "accessMode": "confirm",
  "context": {},
  "instructions": "..."
}
```

The command can return normal text. To request vault changes, include a JSON code block:

```json
{
  "actions": [
    {
      "type": "edit",
      "path": "Example.md",
      "content": "Updated note text"
    }
  ]
}
```

Supported action types are `create`, `edit`, `append`, `delete`, and `rename`.
