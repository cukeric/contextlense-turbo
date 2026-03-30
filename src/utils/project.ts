import { existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

const PROJECT_MARKERS = [
  ".git",
  "package.json",
  "Cargo.toml",
  "pyproject.toml",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "Makefile",
  "CMakeLists.txt",
  ".hg",
  "deno.json",
  "bun.lockb",
];

/**
 * Walk up from cwd to find the project root by looking for common markers.
 * Returns the first directory containing any marker file.
 */
export function detectProjectRoot(startDir?: string): string {
  let dir = resolve(startDir ?? process.cwd());
  const root = dirname(dir);

  while (dir !== root) {
    for (const marker of PROJECT_MARKERS) {
      if (existsSync(join(dir, marker))) {
        return dir;
      }
    }
    dir = dirname(dir);
  }

  // Fallback to cwd if no marker found
  return resolve(startDir ?? process.cwd());
}

const LANGUAGE_MAP: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".jsx": "jsx",
  ".py": "python",
  ".rs": "rust",
  ".go": "go",
  ".java": "java",
  ".rb": "ruby",
  ".php": "php",
  ".c": "c",
  ".cpp": "cpp",
  ".h": "c",
  ".hpp": "cpp",
  ".cs": "c_sharp",
  ".swift": "swift",
  ".kt": "kotlin",
  ".scala": "scala",
  ".lua": "lua",
  ".sh": "bash",
  ".bash": "bash",
  ".zsh": "bash",
  ".css": "css",
  ".html": "html",
  ".vue": "vue",
  ".svelte": "svelte",
};

const DOC_EXTENSIONS = new Set([".md", ".mdx", ".rst", ".txt", ".adoc"]);

const IGNORE_DIRS = new Set([
  "node_modules",
  ".next",
  ".git",
  "dist",
  "build",
  "out",
  ".output",
  "coverage",
  "__pycache__",
  ".cache",
  ".turbo",
  "target",
  "vendor",
  ".venv",
  "venv",
  ".env",
]);

const IGNORE_FILES = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
]);

export function getLanguage(filePath: string): string | null {
  const ext = filePath.slice(filePath.lastIndexOf("."));
  return LANGUAGE_MAP[ext] ?? null;
}

export function isDocFile(filePath: string): boolean {
  const ext = filePath.slice(filePath.lastIndexOf("."));
  return DOC_EXTENSIONS.has(ext);
}

export function isCodeFile(filePath: string): boolean {
  return getLanguage(filePath) !== null;
}

export function shouldIgnoreDir(name: string): boolean {
  return IGNORE_DIRS.has(name) || name.startsWith(".");
}

export function shouldIgnoreFile(name: string): boolean {
  return IGNORE_FILES.has(name);
}
