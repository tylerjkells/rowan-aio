import { HubError, type DocRef, type Hub, type PushDoc, type PushResult, type RemoteDoc, type RemoteKey } from '../src/main/sync/hub'

/**
 * An in-memory hub with the same rules as supabase/migrations: one row per
 * (user, collection, doc_id), a change accepted only from the row's current
 * revision, every user seeing only their own rows and files.
 */
export class FakeServer {
  rows = new Map<string, RemoteDoc & { user: string }>()
  files = new Map<string, Buffer>()
  private rev = 0
  private clock = Date.parse('2026-11-18T12:00:00.000Z')
  /** set to make the next calls fail as if offline */
  offline = false

  now(): string {
    this.clock += 1
    return new Date(this.clock).toISOString()
  }

  nextRev(): number {
    return ++this.rev
  }

  hub(userId: string): FakeHub {
    return new FakeHub(this, userId)
  }

  /** rows a user has, keyed collection:doc_id */
  docsOf(userId: string): Map<string, RemoteDoc> {
    const out = new Map<string, RemoteDoc>()
    for (const r of this.rows.values()) if (r.user === userId) out.set(`${r.collection}:${r.doc_id}`, r)
    return out
  }
}

export class FakeHub implements Hub {
  pushes = 0
  constructor(
    private readonly server: FakeServer,
    readonly userId: string
  ) {}

  private check(): void {
    if (this.server.offline) throw new HubError("Can't reach the sync hub.", 'network')
  }

  private key(r: DocRef): string {
    return `${this.userId}|${r.collection}|${r.doc_id}`
  }

  async changes(sinceAt: string, sinceRev: number, limit: number): Promise<RemoteKey[]> {
    this.check()
    const since = Date.parse(sinceAt)
    return [...this.server.rows.values()]
      .filter((r) => r.user === this.userId)
      .filter((r) => {
        const t = Date.parse(r.updated_at)
        return t > since || (t === since && r.rev > sinceRev)
      })
      .sort((a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at) || a.rev - b.rev)
      .slice(0, limit)
      .map(({ collection, doc_id, rev, deleted, updated_at }) => ({ collection, doc_id, rev, deleted, updated_at }))
  }

  async fetch(refs: DocRef[]): Promise<RemoteDoc[]> {
    this.check()
    const out: RemoteDoc[] = []
    for (const ref of refs) {
      const r = this.server.rows.get(this.key(ref))
      if (r) out.push(JSON.parse(JSON.stringify({ ...r, user: undefined })))
    }
    return out
  }

  async push(docs: PushDoc[]): Promise<PushResult[]> {
    this.check()
    this.pushes += docs.length
    const out: PushResult[] = []
    for (const d of docs) {
      const k = this.key(d)
      const cur = this.server.rows.get(k)
      if (cur && cur.rev !== d.base_rev) {
        out.push({ collection: d.collection, doc_id: d.doc_id, ok: false, rev: cur.rev, deleted: cur.deleted, updated_at: cur.updated_at })
        continue
      }
      const row = {
        user: this.userId,
        collection: d.collection,
        doc_id: d.doc_id,
        body: d.deleted ? null : JSON.parse(JSON.stringify(d.body)),
        deleted: d.deleted,
        rev: this.server.nextRev(),
        updated_at: this.server.now()
      }
      this.server.rows.set(k, row)
      out.push({ collection: d.collection, doc_id: d.doc_id, ok: true, rev: row.rev, deleted: row.deleted, updated_at: row.updated_at })
    }
    return out
  }

  private own(path: string): void {
    if (!path.startsWith(`${this.userId}/`)) throw new HubError('new row violates row-level security policy', 'server', 403)
  }

  async upload(path: string, data: Buffer): Promise<void> {
    this.check()
    this.own(path)
    this.server.files.set(path, Buffer.from(data))
  }

  async download(path: string): Promise<Buffer> {
    this.check()
    this.own(path)
    const f = this.server.files.get(path)
    if (!f) throw new HubError('Object not found', 'missing', 404)
    return Buffer.from(f)
  }

  async remove(paths: string[]): Promise<void> {
    this.check()
    for (const p of paths) {
      this.own(p)
      this.server.files.delete(p)
    }
  }
}
