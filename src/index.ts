import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as fs from "fs/promises";
import * as path from "path";

const VAULT_PATH = process.env.OBSIDIAN_VAULT_PATH;

if (!VAULT_PATH) {
  console.error("OBSIDIAN_VAULT_PATH environment variable is required");
  process.exit(1);
}

// --- Helpers ---

function resolveNotePath(notePath: string): string {
  // Ensure .md extension
  const normalized = notePath.endsWith(".md") ? notePath : `${notePath}.md`;
  const resolved = path.resolve(VAULT_PATH!, normalized);

  // Prevent path traversal
  if (!resolved.startsWith(path.resolve(VAULT_PATH!))) {
    throw new Error("Path traversal not allowed");
  }
  return resolved;
}

function resolveVaultPath(subPath: string): string {
  const resolved = path.resolve(VAULT_PATH!, subPath);
  if (!resolved.startsWith(path.resolve(VAULT_PATH!))) {
    throw new Error("Path traversal not allowed");
  }
  return resolved;
}

async function getAllMarkdownFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory() && !entry.name.startsWith(".")) {
      results.push(...(await getAllMarkdownFiles(fullPath)));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      results.push(path.relative(VAULT_PATH!, fullPath));
    }
  }
  return results;
}

interface ParsedNote {
  frontmatter: Record<string, unknown> | null;
  content: string;
  tags: string[];
  references: string[];
}

function parseNote(raw: string): ParsedNote {
  let frontmatter: Record<string, unknown> | null = null;
  let content = raw;

  // Parse YAML frontmatter
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (fmMatch) {
    frontmatter = {};
    const fmLines = fmMatch[1].split("\n");
    for (const line of fmLines) {
      const colonIdx = line.indexOf(":");
      if (colonIdx > 0) {
        const key = line.slice(0, colonIdx).trim();
        let value: unknown = line.slice(colonIdx + 1).trim();
        // Handle arrays like [tag1, tag2]
        if (typeof value === "string" && value.startsWith("[") && value.endsWith("]")) {
          value = value
            .slice(1, -1)
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
        }
        frontmatter[key] = value;
      }
    }
    content = fmMatch[2];
  }

  // Extract inline tags (#tag)
  const tagMatches = content.match(/(?:^|\s)#([a-zA-Z0-9_\-/]+)/g) || [];
  const tags = tagMatches.map((t) => t.trim().slice(1));

  // Also include frontmatter tags
  if (frontmatter?.tags) {
    const fmTags = Array.isArray(frontmatter.tags)
      ? frontmatter.tags
      : typeof frontmatter.tags === "string"
        ? frontmatter.tags.split(",").map((t: string) => t.trim())
        : [];
    tags.push(...fmTags.map(String));
  }

  // Extract wikilink references [[note]] and [[note|alias]]
  const refMatches = content.match(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g) || [];
  const references = refMatches.map((r) => r.replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/, "$1"));

  return {
    frontmatter,
    content,
    tags: [...new Set(tags)],
    references: [...new Set(references)],
  };
}

// --- MCP Server ---

const server = new McpServer({
  name: "obsidian-mcp",
  version: "1.0.0",
});

// Tool: List notes
server.tool(
  "list_notes",
  "List all markdown notes in the vault, optionally filtered by folder",
  { folder: z.string().optional().describe("Subfolder to list (e.g. 'projects'). Lists entire vault if omitted.") },
  async ({ folder }) => {
    const dir = folder ? resolveVaultPath(folder) : VAULT_PATH!;
    const files = await getAllMarkdownFiles(dir);
    return {
      content: [{ type: "text", text: files.join("\n") }],
    };
  }
);

// Tool: Read note
server.tool(
  "read_note",
  "Read the content of a note. Returns frontmatter, content, tags, and references.",
  { path: z.string().describe("Path to the note relative to vault root (e.g. 'projects/myproject.md' or 'daily/2024-01-01')") },
  async ({ path: notePath }) => {
    const fullPath = resolveNotePath(notePath);
    const raw = await fs.readFile(fullPath, "utf-8");
    const parsed = parseNote(raw);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              path: notePath,
              frontmatter: parsed.frontmatter,
              tags: parsed.tags,
              references: parsed.references,
              content: parsed.content,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

// Tool: Create note
server.tool(
  "create_note",
  "Create a new note in the vault with optional frontmatter and content",
  {
    path: z.string().describe("Path for the new note relative to vault root (e.g. 'projects/newproject')"),
    content: z.string().describe("Markdown content of the note"),
    tags: z.array(z.string()).optional().describe("Tags to add in frontmatter"),
    frontmatter: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("Additional frontmatter key-value pairs"),
  },
  async ({ path: notePath, content, tags, frontmatter }) => {
    const fullPath = resolveNotePath(notePath);

    // Check if file already exists
    try {
      await fs.access(fullPath);
      return {
        content: [{ type: "text", text: `Error: Note already exists at ${notePath}. Use edit_note to modify it.` }],
        isError: true,
      };
    } catch {
      // File doesn't exist, good
    }

    // Build the note
    let noteContent = "";
    const fm: Record<string, unknown> = { ...frontmatter };
    if (tags && tags.length > 0) {
      fm.tags = tags;
    }

    if (Object.keys(fm).length > 0) {
      noteContent += "---\n";
      for (const [key, value] of Object.entries(fm)) {
        if (Array.isArray(value)) {
          noteContent += `${key}: [${value.join(", ")}]\n`;
        } else {
          noteContent += `${key}: ${value}\n`;
        }
      }
      noteContent += "---\n\n";
    }

    noteContent += content;

    // Create parent directories if needed
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, noteContent, "utf-8");

    return {
      content: [{ type: "text", text: `Created note: ${notePath}` }],
    };
  }
);

// Tool: Edit note
server.tool(
  "edit_note",
  "Edit an existing note. Can replace the entire content or do a find-and-replace.",
  {
    path: z.string().describe("Path to the note relative to vault root"),
    content: z
      .string()
      .optional()
      .describe("New full content to replace the entire note (excluding frontmatter unless includeFrontmatter is true)"),
    find: z.string().optional().describe("Text to find in the note (for partial edit)"),
    replace: z.string().optional().describe("Text to replace the found text with"),
    includeFrontmatter: z
      .boolean()
      .optional()
      .describe("If true, the content replaces the entire file including frontmatter. Default: false"),
  },
  async ({ path: notePath, content, find, replace, includeFrontmatter }) => {
    const fullPath = resolveNotePath(notePath);
    const raw = await fs.readFile(fullPath, "utf-8");

    let newContent: string;

    if (find !== undefined && replace !== undefined) {
      // Find and replace
      if (!raw.includes(find)) {
        return {
          content: [{ type: "text", text: `Error: Could not find the specified text in the note.` }],
          isError: true,
        };
      }
      newContent = raw.replace(find, replace);
    } else if (content !== undefined) {
      if (includeFrontmatter) {
        newContent = content;
      } else {
        // Preserve existing frontmatter
        const fmMatch = raw.match(/^(---\n[\s\S]*?\n---\n?)/);
        newContent = fmMatch ? fmMatch[1] + "\n" + content : content;
      }
    } else {
      return {
        content: [
          {
            type: "text",
            text: "Error: Provide either 'content' for full replacement or 'find'+'replace' for partial edit.",
          },
        ],
        isError: true,
      };
    }

    await fs.writeFile(fullPath, newContent, "utf-8");
    return {
      content: [{ type: "text", text: `Updated note: ${notePath}` }],
    };
  }
);

// Tool: Delete note
server.tool(
  "delete_note",
  "Delete a note from the vault",
  { path: z.string().describe("Path to the note relative to vault root") },
  async ({ path: notePath }) => {
    const fullPath = resolveNotePath(notePath);
    await fs.unlink(fullPath);
    return {
      content: [{ type: "text", text: `Deleted note: ${notePath}` }],
    };
  }
);

// Tool: Search notes by tag
server.tool(
  "search_by_tag",
  "Search for notes that contain a specific tag (inline #tag or in frontmatter)",
  { tag: z.string().describe("Tag to search for (without the # prefix)") },
  async ({ tag }) => {
    const allFiles = await getAllMarkdownFiles(VAULT_PATH!);
    const matches: string[] = [];

    for (const file of allFiles) {
      const fullPath = path.join(VAULT_PATH!, file);
      const raw = await fs.readFile(fullPath, "utf-8");
      const parsed = parseNote(raw);
      if (parsed.tags.includes(tag)) {
        matches.push(file);
      }
    }

    return {
      content: [
        {
          type: "text",
          text: matches.length > 0 ? matches.join("\n") : `No notes found with tag: ${tag}`,
        },
      ],
    };
  }
);

// Tool: Search notes by content
server.tool(
  "search_notes",
  "Search for notes containing specific text in their content",
  { query: z.string().describe("Text to search for in note contents") },
  async ({ query }) => {
    const allFiles = await getAllMarkdownFiles(VAULT_PATH!);
    const matches: { path: string; snippet: string }[] = [];

    for (const file of allFiles) {
      const fullPath = path.join(VAULT_PATH!, file);
      const raw = await fs.readFile(fullPath, "utf-8");
      const idx = raw.toLowerCase().indexOf(query.toLowerCase());
      if (idx !== -1) {
        const start = Math.max(0, idx - 50);
        const end = Math.min(raw.length, idx + query.length + 50);
        matches.push({
          path: file,
          snippet: "..." + raw.slice(start, end).replace(/\n/g, " ") + "...",
        });
      }
    }

    return {
      content: [
        {
          type: "text",
          text:
            matches.length > 0
              ? JSON.stringify(matches, null, 2)
              : `No notes found containing: ${query}`,
        },
      ],
    };
  }
);

// Tool: Get backlinks
server.tool(
  "get_backlinks",
  "Find all notes that reference a given note via [[wikilinks]]",
  { noteName: z.string().describe("Name of the note to find backlinks for (without .md extension)") },
  async ({ noteName }) => {
    const allFiles = await getAllMarkdownFiles(VAULT_PATH!);
    const backlinks: string[] = [];

    for (const file of allFiles) {
      const fullPath = path.join(VAULT_PATH!, file);
      const raw = await fs.readFile(fullPath, "utf-8");
      const parsed = parseNote(raw);
      if (parsed.references.some((ref) => ref === noteName || ref.endsWith(`/${noteName}`))) {
        backlinks.push(file);
      }
    }

    return {
      content: [
        {
          type: "text",
          text:
            backlinks.length > 0
              ? `Notes referencing "${noteName}":\n${backlinks.join("\n")}`
              : `No backlinks found for: ${noteName}`,
        },
      ],
    };
  }
);

// Tool: Add/update tags
server.tool(
  "manage_tags",
  "Add or remove tags from a note's frontmatter",
  {
    path: z.string().describe("Path to the note relative to vault root"),
    add: z.array(z.string()).optional().describe("Tags to add"),
    remove: z.array(z.string()).optional().describe("Tags to remove"),
  },
  async ({ path: notePath, add, remove }) => {
    const fullPath = resolveNotePath(notePath);
    const raw = await fs.readFile(fullPath, "utf-8");
    const parsed = parseNote(raw);

    let currentTags = new Set(parsed.tags);
    if (add) add.forEach((t) => currentTags.add(t));
    if (remove) remove.forEach((t) => currentTags.delete(t));

    const tagsArray = [...currentTags];

    // Rebuild the file with updated frontmatter
    const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    let newFrontmatter: Record<string, string> = {};
    let bodyContent = raw;

    if (fmMatch) {
      // Parse existing frontmatter lines (preserving non-tag entries)
      const fmLines = fmMatch[1].split("\n");
      for (const line of fmLines) {
        const colonIdx = line.indexOf(":");
        if (colonIdx > 0) {
          const key = line.slice(0, colonIdx).trim();
          if (key !== "tags") {
            newFrontmatter[key] = line.slice(colonIdx + 1).trim();
          }
        }
      }
      bodyContent = fmMatch[2];
    }

    let result = "---\n";
    if (tagsArray.length > 0) {
      result += `tags: [${tagsArray.join(", ")}]\n`;
    }
    for (const [key, value] of Object.entries(newFrontmatter)) {
      result += `${key}: ${value}\n`;
    }
    result += "---\n" + bodyContent;

    await fs.writeFile(fullPath, result, "utf-8");

    return {
      content: [
        {
          type: "text",
          text: `Updated tags for ${notePath}: [${tagsArray.join(", ")}]`,
        },
      ],
    };
  }
);

// --- Start ---

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Obsidian MCP server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
