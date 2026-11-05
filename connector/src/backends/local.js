import { promises as fs } from "node:fs";
import path from "node:path";

const TEXT_EXTENSIONS = new Set([".md", ".txt", ".json", ".csv"]);

export class LocalFolderBackend {
  constructor(root) {
    if (!root) throw new Error("LocalFolderBackend needs a root folder");
    this.root = path.resolve(root);
  }

  resolve(relPath = "") {
    if (path.isAbsolute(relPath)) throw new Error("Paths are relative to the library root");
    const full = path.resolve(this.root, relPath);
    if (full !== this.root && !full.startsWith(this.root + path.sep)) {
      throw new Error("Path is outside the library");
    }
    return full;
  }

  async list(relPath = "") {
    const dir = this.resolve(relPath);
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => !e.name.startsWith("."))
      .map((e) => ({
        path: path.posix.join(relPath.split(path.sep).join("/"), e.name),
        type: e.isDirectory() ? "folder" : "file",
      }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  async read(relPath) {
    const full = this.resolve(relPath);
    const stat = await fs.stat(full);
    if (!stat.isFile()) throw new Error("Not a file");
    return fs.readFile(full, "utf8");
  }

  async *walk(relPath = "") {
    for (const entry of await this.list(relPath)) {
      if (entry.type === "folder") yield* this.walk(entry.path);
      else if (TEXT_EXTENSIONS.has(path.extname(entry.path).toLowerCase())) yield entry.path;
    }
  }

  async search(query, limit = 10) {
    const needle = query.toLowerCase();
    const results = [];
    for await (const file of this.walk("")) {
      const lines = (await this.read(file)).split("\n");
      const hits = [];
      lines.forEach((line, i) => {
        if (line.toLowerCase().includes(needle)) hits.push({ line: i + 1, text: line.trim().slice(0, 240) });
      });
      if (hits.length) results.push({ path: file, matches: hits.slice(0, 5), total: hits.length });
      if (results.length >= limit) break;
    }
    return results;
  }

  async write(relPath, content) {
    const full = this.resolve(relPath);
    if (full === this.root) throw new Error("Cannot write to the library root");
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, "utf8");
    return { path: relPath, bytes: Buffer.byteLength(content, "utf8") };
  }
}
