# vault.example — bring your own knowledge vault

The Agon consulting layer (MCP server) reads a **private, Karpathy-style LLM wiki
vault** of sports-science notes to give evidence-grounded answers. That vault is
**not** in this repo — it's copyrighted source material and must never be
committed (see CLAUDE.md "Knowledge Vault Policy").

This directory ships **2–3 original sample pages** so you can see the expected
format, then build your own:

1. Copy this directory somewhere private, outside the repo:
   `cp -r vault.example ~/agon-vault`
2. Point the server at it in `.env.local`: `AGON_VAULT_PATH=/absolute/path/to/agon-vault`
3. Replace these samples with your own notes.

## Page format

- One markdown file per topic (`vo2max.md`, `training-load-atl-ctl-tsb.md`, …).
- Optional YAML frontmatter (`title`, `tags`).
- Cross-link related pages with `[[wiki-links]]`.
- The MCP tools `list_vault_pages`, `search_vault`, and `read_vault_page` expose
  these to any MCP client — no special structure required beyond markdown.

Build your own vault with the owner's public `llm-wiki` tooling (linked from the
project README).
