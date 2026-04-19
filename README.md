# Obsidian MCP Server

An MCP (Model Context Protocol) server that provides tools to read, create, edit, delete, and search notes in an Obsidian vault. Supports Obsidian-specific features like tags, frontmatter, and `[[wikilink]]` references.

## Tools

| Tool | Description |
|------|-------------|
| `list_notes` | List all markdown notes in the vault, optionally filtered by folder |
| `read_note` | Read a note with parsed frontmatter, tags, and references |
| `create_note` | Create a new note with optional frontmatter and tags |
| `edit_note` | Edit a note — full replacement or find-and-replace |
| `delete_note` | Delete a note from the vault |
| `search_notes` | Full-text search across all notes |
| `search_by_tag` | Find notes by tag (inline `#tag` or frontmatter) |
| `get_backlinks` | Find all notes that reference a given note via `[[wikilinks]]` |
| `manage_tags` | Add or remove tags from a note's frontmatter |

## Setup

```bash
npm install
npm run build
```

## Configuration

Set the `OBSIDIAN_VAULT_PATH` environment variable to the path of your Obsidian vault:

```bash
OBSIDIAN_VAULT_PATH=/path/to/your/vault npm start
```

### Claude Desktop / VS Code

Add to your MCP config:

```json
{
  "mcpServers": {
    "obsidian": {
      "command": "node",
      "args": ["/absolute/path/to/obsidian-mcp/dist/index.js"],
      "env": {
        "OBSIDIAN_VAULT_PATH": "/path/to/your/vault"
      }
    }
  }
}
```

## Obsidian Features Supported

- **Frontmatter** — YAML frontmatter parsing and preservation on edits
- **Tags** — Both inline `#tags` and frontmatter `tags:` field
- **Wikilinks** — `[[note]]` and `[[note|alias]]` reference extraction
- **Backlinks** — Reverse-lookup of which notes link to a given note
- **Folder structure** — Reads and creates notes respecting vault folder hierarchy
