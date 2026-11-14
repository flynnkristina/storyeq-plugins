// Google Drive backend: the library is a Shared Drive, addressed by folder paths
// like "skills/INDEX.md". Same four methods as LocalFolderBackend.
//
// - Service accounts own no Drive storage, so everything lives in the Shared Drive.
// - Every call carries supportsAllDrives; listings are scoped to the one drive.
// - The key is read from a file path (LIBRARY_KEY_FILE). It never ships in a plugin.
// - Reader and writer are separate service accounts (Viewer vs Content manager),
//   so Google refuses a reader's write on top of the role check in library.js.
// - Google Docs are read as markdown, Google Sheets as CSV (first sheet); everything the
//   writer creates is a plain .md file.
// - A read-only connection asks Google for read-only Drive access, a second lock beside
//   the Viewer role.
// - Lookups go one folder at a time by name, and folder ids are remembered for the life of
//   the connection. Search asks Drive which files contain the words and opens only those.

import { GoogleAuth } from "google-auth-library";
import path from "node:path";

const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const FOLDER = "application/vnd.google-apps.folder";
const GDOC = "application/vnd.google-apps.document";
const GSHEET = "application/vnd.google-apps.spreadsheet";
const SCOPE_WRITE = "https://www.googleapis.com/auth/drive";
const SCOPE_READ = "https://www.googleapis.com/auth/drive.readonly";
const RECENT_MS = 60 * 60 * 1000;
const TEXT_EXTENSIONS = new Set([".md", ".txt", ".json", ".csv"]);

const quote = (s) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

function splitPath(relPath = "") {
  if (path.isAbsolute(relPath)) throw new Error("Paths are relative to the library root");
  const parts = relPath.split("/").filter((p) => p && p !== ".");
  if (parts.some((p) => p === "..")) throw new Error("Path is outside the library");
  return parts;
}

export class DriveBackend {
  constructor({ driveId, keyFile, credentials, client, readOnly = false } = {}) {
    if (!driveId) throw new Error("DriveBackend needs LIBRARY_DRIVE_ID");
    if (!keyFile && !credentials && !client) throw new Error("DriveBackend needs a key");
    this.driveId = driveId;
    this.client = client;
    this.readOnly = readOnly;
    this.scope = readOnly ? SCOPE_READ : SCOPE_WRITE;
    this.folders = new Map(); // "a/b" -> folder item, for this connection's lifetime
    this.parents = new Map(); // id -> { name, parent }, for turning search hits into paths
    this.auth = client ? null : new GoogleAuth({ ...(credentials ? { credentials } : { keyFile }), scopes: [this.scope] });
  }

  driveParams(extra = {}) {
    return { supportsAllDrives: true, includeItemsFromAllDrives: true, corpora: "drive", driveId: this.driveId, ...extra };
  }

  async http(opts) {
    if (!this.client) this.client = await this.auth.getClient();
    try {
      return (await this.client.request(opts)).data;
    } catch (err) {
      const status = err.response?.status;
      const msg = err.response?.data?.error?.message ?? err.message;
      if (status === 403) throw new Error(`Google refused this (${msg}). This connector may be read-only.`);
      throw new Error(`Google Drive error${status ? ` ${status}` : ""}: ${msg}`);
    }
  }

  async children(folderId) {
    const files = [];
    let pageToken;
    do {
      const data = await this.http({
        url: `${API}/files`,
        params: this.driveParams({
          q: `${quote(folderId)} in parents and trashed=false`,
          fields: "nextPageToken, files(id,name,mimeType)",
          pageSize: 200,
          pageToken,
        }),
      });
      files.push(...data.files);
      pageToken = data.nextPageToken;
    } while (pageToken);
    return files.filter((f) => !f.name.startsWith("."));
  }

  // One item by name inside one folder: a single query, not a listing of the folder.
  async child(folderId, name) {
    if (name.startsWith(".")) return undefined;
    const data = await this.http({
      url: `${API}/files`,
      params: this.driveParams({
        q: `${quote(folderId)} in parents and name = ${quote(name)} and trashed=false`,
        fields: "files(id,name,mimeType)",
        pageSize: 10,
      }),
    });
    const matches = data.files ?? [];
    if (matches.length > 1) throw new Error(`Two items are both named "${name}"; rename one in Drive`);
    return matches[0];
  }

  async findFrom(parts, useCache) {
    let current = { id: this.driveId, mimeType: FOLDER, name: "" };
    let usedCache = false;
    for (let i = 0; i < parts.length; i++) {
      if (current.mimeType !== FOLDER) return { item: undefined, usedCache };
      const key = parts.slice(0, i + 1).join("/");
      const known = useCache && this.folders.get(key);
      if (known) {
        current = known;
        usedCache = true;
        continue;
      }
      current = await this.child(current.id, parts[i]);
      if (!current) return { item: undefined, usedCache };
      if (current.mimeType === FOLDER) this.folders.set(key, current);
    }
    return { item: current, usedCache };
  }

  async find(relPath) {
    const parts = splitPath(relPath);
    const first = await this.findFrom(parts, true);
    if (first.item || !first.usedCache) return first.item;
    // A remembered folder may have been moved or renamed in Drive since; look again from the top.
    this.folders.clear();
    return (await this.findFrom(parts, false)).item;
  }

  async list(relPath = "") {
    const folder = await this.find(relPath);
    if (!folder) throw new Error(`No folder at "${relPath}"`);
    if (folder.mimeType !== FOLDER) throw new Error(`"${relPath}" is a file, not a folder`);
    const base = splitPath(relPath).join("/");
    return (await this.children(folder.id))
      .map((f) => ({ path: base ? `${base}/${f.name}` : f.name, type: f.mimeType === FOLDER ? "folder" : "file" }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  async contents(file) {
    if (file.mimeType === GDOC) {
      return this.http({ url: `${API}/files/${file.id}/export`, params: { mimeType: "text/markdown" }, responseType: "text" });
    }
    if (file.mimeType === GSHEET) {
      return this.http({ url: `${API}/files/${file.id}/export`, params: { mimeType: "text/csv" }, responseType: "text" });
    }
    if (file.mimeType.startsWith("application/vnd.google-apps")) {
      throw new Error(`"${file.name}" is a Google ${file.mimeType.split(".").pop()}, which the library can't read as text`);
    }
    return this.http({ url: `${API}/files/${file.id}`, params: { alt: "media", supportsAllDrives: true }, responseType: "text" });
  }

  async read(relPath) {
    const file = await this.find(relPath);
    if (!file) throw new Error(`No file at "${relPath}"`);
    if (file.mimeType === FOLDER) throw new Error("Not a file");
    return String(await this.contents(file));
  }

  async *walk(relPath = "") {
    for (const entry of await this.list(relPath)) {
      if (entry.type === "folder") yield* this.walk(entry.path);
      else yield entry.path;
    }
  }

  // The path of a search hit, from its parent chain. Returns null if it isn't in this drive's
  // tree or sits under a hidden (dot) name.
  async pathOf(file) {
    const names = [file.name];
    let parent = file.parents?.[0];
    while (parent && parent !== this.driveId) {
      let node = this.parents.get(parent);
      if (!node) {
        const data = await this.http({ url: `${API}/files/${parent}`, params: { fields: "id,name,parents", supportsAllDrives: true } });
        node = { name: data.name, parent: data.parents?.[0] };
        this.parents.set(parent, node);
      }
      names.unshift(node.name);
      parent = node.parent;
    }
    if (parent !== this.driveId || names.some((n) => n.startsWith("."))) return null;
    return names.join("/");
  }

  readable(file) {
    if (file.mimeType === GDOC || file.mimeType === GSHEET) return true;
    if (file.mimeType.startsWith("application/vnd.google-apps")) return false;
    const ext = path.extname(file.name).toLowerCase();
    return !ext || TEXT_EXTENSIONS.has(ext);
  }

  // Files matching a Drive query, every page.
  async query(q) {
    const files = [];
    let pageToken;
    do {
      const data = await this.http({
        url: `${API}/files`,
        params: this.driveParams({ q, fields: "nextPageToken, files(id,name,mimeType,parents)", pageSize: 100, pageToken }),
      });
      files.push(...(data.files ?? []));
      pageToken = data.nextPageToken;
    } while (pageToken);
    return files;
  }

  // Drive finds the files that contain the words; only those are opened, to show the lines.
  // Drive's text index lags behind new writes, so anything changed in the last hour is
  // checked too.
  async search(query, limit = 10) {
    const needle = query.toLowerCase().trim();
    if (!needle) return [];
    const phrase = needle.replace(/["\\]/g, " ").trim();
    const notFolder = `trashed=false and mimeType != ${quote(FOLDER)}`;
    const since = new Date(Date.now() - RECENT_MS).toISOString();
    const [matched, recent] = await Promise.all([
      this.query(`fullText contains ${quote(`"${phrase}"`)} and ${notFolder}`),
      this.query(`modifiedTime > ${quote(since)} and ${notFolder}`),
    ]);
    const seen = new Set();
    const candidates = [...matched, ...recent].filter((f) => !seen.has(f.id) && seen.add(f.id));
    const results = [];
    {
      for (const file of candidates) {
        if (!this.readable(file)) continue;
        const relPath = await this.pathOf(file);
        if (!relPath) continue;
        let text;
        try {
          text = String(await this.contents(file));
        } catch {
          continue;
        }
        const hits = [];
        text.split("\n").forEach((line, i) => {
          if (line.toLowerCase().includes(needle)) hits.push({ line: i + 1, text: line.trim().slice(0, 240) });
        });
        if (hits.length) results.push({ path: relPath, matches: hits.slice(0, 5), total: hits.length });
        if (results.length >= limit) return results;
      }
    }
    return results;
  }

  // The old way: open every file. Kept for testing and comparison only.
  async searchByWalking(query, limit = 10) {
    const needle = query.toLowerCase();
    const results = [];
    for await (const file of this.walk("")) {
      const ext = path.extname(file).toLowerCase();
      let text;
      try {
        text = TEXT_EXTENSIONS.has(ext) || !ext ? await this.read(file) : null;
      } catch {
        text = null;
      }
      if (!text) continue;
      const hits = [];
      text.split("\n").forEach((line, i) => {
        if (line.toLowerCase().includes(needle)) hits.push({ line: i + 1, text: line.trim().slice(0, 240) });
      });
      if (hits.length) results.push({ path: file, matches: hits.slice(0, 5), total: hits.length });
      if (results.length >= limit) break;
    }
    return results;
  }

  async ensureFolder(parts) {
    let parentId = this.driveId;
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i];
      const key = parts.slice(0, i + 1).join("/");
      let folder = this.folders.get(key) ?? (await this.child(parentId, name));
      if (!folder) {
        folder = await this.http({
          url: `${API}/files`,
          method: "POST",
          params: { supportsAllDrives: true, fields: "id,name,mimeType" },
          data: { name, mimeType: FOLDER, parents: [parentId] },
        });
      } else if (folder.mimeType !== FOLDER) {
        throw new Error(`"${name}" is a file, not a folder`);
      }
      this.folders.set(key, folder);
      parentId = folder.id;
    }
    return parentId;
  }

  async write(relPath, content) {
    const parts = splitPath(relPath);
    if (!parts.length) throw new Error("Cannot write to the library root");
    const name = parts.pop();
    const parentId = await this.ensureFolder(parts);
    const existing = await this.child(parentId, name);
    if (existing && existing.mimeType.startsWith("application/vnd.google-apps")) {
      throw new Error(`"${relPath}" is a Google file; edit it in Drive, or write to a .md file instead`);
    }
    const mimeType = name.endsWith(".md") ? "text/markdown" : "text/plain";
    if (existing) {
      await this.http({
        url: `${UPLOAD}/files/${existing.id}`,
        method: "PATCH",
        params: { uploadType: "media", supportsAllDrives: true },
        headers: { "Content-Type": mimeType },
        data: content,
      });
    } else {
      const boundary = "library-boundary";
      const body =
        `--${boundary}\r\nContent-Type: application/json\r\n\r\n` +
        JSON.stringify({ name, parents: [parentId], mimeType }) +
        `\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n${content}\r\n--${boundary}--`;
      await this.http({
        url: `${UPLOAD}/files`,
        method: "POST",
        params: { uploadType: "multipart", supportsAllDrives: true },
        headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
        data: body,
      });
    }
    return { path: [...parts, name].join("/"), bytes: Buffer.byteLength(content, "utf8"), created: !existing };
  }
}
