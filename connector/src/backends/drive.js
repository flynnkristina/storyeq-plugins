// Google Drive backend: the library is a Shared Drive, addressed by folder paths
// like "skills/INDEX.md". Same four methods as LocalFolderBackend.
//
// - Service accounts own no Drive storage, so everything lives in the Shared Drive.
// - Every call carries supportsAllDrives; listings are scoped to the one drive.
// - The key is read from a file path (LIBRARY_KEY_FILE). It never ships in a plugin.
// - Reader and writer are separate service accounts (Viewer vs Content manager),
//   so Google refuses a reader's write on top of the role check in library.js.
// - Google Docs are read as markdown; everything the writer creates is a plain .md file.

import { GoogleAuth } from "google-auth-library";
import path from "node:path";

const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const FOLDER = "application/vnd.google-apps.folder";
const GDOC = "application/vnd.google-apps.document";
const TEXT_EXTENSIONS = new Set([".md", ".txt", ".json", ".csv"]);

const quote = (s) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

function splitPath(relPath = "") {
  if (path.isAbsolute(relPath)) throw new Error("Paths are relative to the library root");
  const parts = relPath.split("/").filter((p) => p && p !== ".");
  if (parts.some((p) => p === "..")) throw new Error("Path is outside the library");
  return parts;
}

export class DriveBackend {
  constructor({ driveId, keyFile, credentials, client } = {}) {
    if (!driveId) throw new Error("DriveBackend needs LIBRARY_DRIVE_ID");
    if (!keyFile && !credentials && !client) throw new Error("DriveBackend needs a key");
    this.driveId = driveId;
    this.client = client;
    this.auth = client ? null : new GoogleAuth({ ...(credentials ? { credentials } : { keyFile }), scopes: ["https://www.googleapis.com/auth/drive"] });
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
        params: {
          q: `${quote(folderId)} in parents and trashed=false`,
          fields: "nextPageToken, files(id,name,mimeType)",
          pageSize: 200,
          pageToken,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
          corpora: "drive",
          driveId: this.driveId,
        },
      });
      files.push(...data.files);
      pageToken = data.nextPageToken;
    } while (pageToken);
    return files.filter((f) => !f.name.startsWith("."));
  }

  async child(folderId, name) {
    const matches = (await this.children(folderId)).filter((f) => f.name === name);
    if (matches.length > 1) throw new Error(`Two items are both named "${name}"; rename one in Drive`);
    return matches[0];
  }

  async find(relPath) {
    let current = { id: this.driveId, mimeType: FOLDER, name: "" };
    for (const part of splitPath(relPath)) {
      if (current.mimeType !== FOLDER) return undefined;
      current = await this.child(current.id, part);
      if (!current) return undefined;
    }
    return current;
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

  async search(query, limit = 10) {
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
    for (const name of parts) {
      let folder = await this.child(parentId, name);
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
