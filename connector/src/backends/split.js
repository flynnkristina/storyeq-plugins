// Sends anything under private/ to a separate private backend, anything under answers/ to a
// separate answers backend, and everything else to the main one.
//
// The rule this exists for: a private/ or answers/ path never resolves to the main library.
// If the drive for one isn't connected, its paths are refused outright, so a private file or
// an eval answer can't quietly land where the reader account (or the eval bot) can see it.

export const PRIVATE = "private";
export const ANSWERS = "answers";

const parts = (p = "") => String(p).split("/").filter((x) => x && x !== ".");
const firstIs = (p, name) => parts(p)[0]?.toLowerCase() === name;
export const isPrivatePath = (p = "") => firstIs(p, PRIVATE);
export const isAnswersPath = (p = "") => firstIs(p, ANSWERS);

// reserveAnswers: whether answers/ is kept off the main library. On for the writer and the eval
// bot. Off for the reader, so a reader's connection behaves exactly as it did before answers/
// existed (it never has an answers drive, and never had any special answers/ handling).
export class SplitBackend {
  constructor({ main, privateBackend = null, answersBackend = null, unavailable, answersUnavailable, reserveAnswers = true }) {
    if (!main) throw new Error("SplitBackend needs a main backend");
    this.main = main;
    this.reserveAnswers = reserveAnswers;
    this.sections = {
      [PRIVATE]: {
        backend: privateBackend,
        unavailable: unavailable ?? "Private files aren't connected on this machine, so nothing under private/ can be read or written.",
      },
      [ANSWERS]: {
        backend: answersBackend,
        unavailable: answersUnavailable ?? "The answers drive isn't connected on this machine, so nothing under answers/ can be read or written.",
      },
    };
  }

  reserved(p) {
    return isPrivatePath(p) || (this.reserveAnswers && isAnswersPath(p));
  }

  route(p = "") {
    const name = isPrivatePath(p) ? PRIVATE : this.reserveAnswers && isAnswersPath(p) ? ANSWERS : null;
    if (!name) return { backend: this.main, inner: p ?? "", prefix: "" };
    const section = this.sections[name];
    if (!section.backend) throw new Error(section.unavailable);
    return { backend: section.backend, inner: parts(p).slice(1).join("/"), prefix: name };
  }

  connected() {
    return Object.entries(this.sections).filter(([, s]) => s.backend).map(([name, s]) => [name, s.backend]);
  }

  async list(p = "") {
    const r = this.route(p);
    const items = (await r.backend.list(r.inner)).map((e) => (r.prefix ? { ...e, path: `${r.prefix}/${e.path}` } : e));
    if (parts(p).length) return items;
    const top = items.filter((e) => !this.reserved(e.path));
    for (const [name] of this.connected()) top.push({ path: name, type: "folder" });
    return top.sort((a, b) => a.path.localeCompare(b.path));
  }

  async read(p) {
    const r = this.route(p);
    return r.backend.read(r.inner);
  }

  async search(query, limit = 10) {
    const found = (await this.main.search(query, limit)).filter((h) => !this.reserved(h.path));
    for (const [name, backend] of this.connected()) {
      if (found.length >= limit) break;
      const hits = await backend.search(query, limit - found.length);
      found.push(...hits.map((h) => ({ ...h, path: `${name}/${h.path}` })));
    }
    return found.slice(0, limit);
  }

  async write(p, content) {
    const r = this.route(p);
    if (r.prefix && !r.inner) throw new Error(`Give a file name inside ${r.prefix}/`);
    const result = await r.backend.write(r.inner, content);
    return r.prefix ? { ...result, path: `${r.prefix}/${result.path}`, [r.prefix]: true } : result;
  }
}
