import { promises as fs } from 'fs';
import path from 'path';

// Knowledge-vault access (CLAUDE.md Knowledge Vault Policy). The vault is PRIVATE,
// copyrighted material that lives OUTSIDE the repo — its path comes only from
// AGON_VAULT_PATH. Every page read is confined to the vault root: resolveVaultPath
// rejects any name that escapes it (`../`, absolute paths), so a model can't read
// arbitrary files off disk through these tools.

/** Absolute, validated vault root. Throws a friendly error if not configured. */
export function vaultRoot(): string {
  const root = process.env.AGON_VAULT_PATH;
  if (!root) {
    throw new Error(
      'mcp: AGON_VAULT_PATH is not set — the knowledge vault is unavailable. ' +
        'Point it at your vault directory (absolute path, outside this repo).',
    );
  }
  if (!path.isAbsolute(root)) {
    throw new Error('mcp: AGON_VAULT_PATH must be an absolute path');
  }
  return path.resolve(root);
}

/**
 * Pure: resolve a requested page under `root`, rejecting anything that escapes
 * it. Appends `.md` if missing. Exported for unit testing the traversal guard.
 */
export function resolveVaultPath(root: string, requested: string): string {
  const rootResolved = path.resolve(root);
  const withExt = requested.endsWith('.md') ? requested : `${requested}.md`;
  const target = path.resolve(rootResolved, withExt);
  const rel = path.relative(rootResolved, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`mcp: vault page escapes the vault root: ${requested}`);
  }
  return target;
}

/** Recursively collect `.md` files under `dir`, as paths relative to `root`. */
async function walk(dir: string, root: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const e of entries) {
    if (e.name.startsWith('.')) continue; // skip dotfiles/dirs
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...(await walk(full, root)));
    } else if (e.isFile() && e.name.endsWith('.md')) {
      out.push(path.relative(root, full));
    }
  }
  return out;
}

/** Every markdown page in the vault, as relative paths, sorted. */
export async function listVaultPages(): Promise<string[]> {
  const root = vaultRoot();
  return (await walk(root, root)).sort();
}

/** Full markdown of one page (name with or without `.md`). */
export async function readVaultPage(name: string): Promise<string> {
  const root = vaultRoot();
  return fs.readFile(resolveVaultPath(root, name), 'utf8');
}

export interface VaultMatch {
  page: string;
  line: number;
  text: string;
}

/** Case-insensitive substring search across all pages; capped result set. */
export async function searchVault(
  query: string,
  maxMatches = 40,
): Promise<VaultMatch[]> {
  const root = vaultRoot();
  const pages = await walk(root, root);
  const q = query.toLowerCase();
  const out: VaultMatch[] = [];
  for (const page of pages) {
    const content = await fs.readFile(path.join(root, page), 'utf8');
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]!.toLowerCase().includes(q)) {
        out.push({ page, line: i + 1, text: lines[i]!.trim() });
        if (out.length >= maxMatches) return out;
      }
    }
  }
  return out;
}
