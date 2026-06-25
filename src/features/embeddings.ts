// src/features/embeddings.ts
// Phase 6 — local, contextual semantic RE-RANK tier.
//
// Privacy: everything is local. The only network event is the optional one-time
// model-weights download when the user first enables the tier. With the tier off
// or the model absent, every export degrades to a no-op and the plugin behaves
// exactly as Phases 0–5.
//
// NOTE: the model backend (@xenova/transformers) requires a real Obsidian/Electron
// runtime and a downloaded model; it is loaded lazily via dynamic import and is
// NOT bundled into main.js. The pure logic here (cosine, semScore, cache,
// invalidation) is runtime-independent and unit-tested.

export const DEFAULT_MODEL = "Xenova/paraphrase-multilingual-MiniLM-L12-v2";

// ---------------------------------------------------------------------------
// Pure vector math
// ---------------------------------------------------------------------------

/** Cosine similarity of two equal-length vectors in [-1, 1]. */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na  += a[i] * a[i];
    nb  += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Map cosine [-1,1] → semScore [0,1]. */
export function toSemScore(cos: number): number {
  return Math.max(0, Math.min(1, (cos + 1) / 2));
}

// ---------------------------------------------------------------------------
// Embedder backend (pluggable; real one is lazy-loaded transformers.js)
// ---------------------------------------------------------------------------

export interface Embedder {
  isReady(): boolean;
  /** Returns an L2-normalized embedding, or null if unavailable. */
  embed(text: string): Promise<Float32Array | null>;
}

// Minimal structural type for the parts of @xenova/transformers we touch — lets
// us avoid `any` (and an eslint-disable) for the lazily-imported module.
type FeatureExtractor = (text: string, opts: { pooling: string; normalize: boolean }) => Promise<{ data: Float32Array | number[] }>;
interface TransformersModule {
  env: {
    allowRemoteModels: boolean;
    allowLocalModels: boolean;
    localModelPath: string;
    backends?: { onnx?: { wasm?: { numThreads: number; wasmPaths: string } } };
  };
  pipeline: (task: string, model: string) => Promise<FeatureExtractor>;
}

/**
 * transformers.js feature-extraction backend. Loaded lazily so main.js never
 * pays for it until the user enables semantics, and so its absence is survivable.
 */
export class TransformersEmbedder implements Embedder {
  private pipe: FeatureExtractor | null = null;
  private status: "off" | "loading" | "ready" | "error" = "off";
  private lastError = "";

  constructor(
    private model = DEFAULT_MODEL,
    private localModelPath = "",
  ) {}

  isReady(): boolean { return this.status === "ready"; }
  getStatus(): string { return this.status; }
  getError(): string { return this.lastError; }

  async init(): Promise<boolean> {
    if (this.status === "ready") return true;
    this.status = "loading";
    try {
      // Bundled (see esbuild config); imported lazily so init cost is paid only on enable.
      const tf = (await import("@xenova/transformers")) as unknown as TransformersModule;
      // Use the wasm runtime, single-threaded (Electron renderer has no
      // cross-origin isolation for multithreaded SharedArrayBuffer wasm), and
      // load the wasm binaries from the matching CDN build.
      if (tf.env?.backends?.onnx?.wasm) {
        tf.env.backends.onnx.wasm.numThreads = 1;
        tf.env.backends.onnx.wasm.wasmPaths =
          "https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2/dist/";
      }
      let modelToLoad = this.model;
      if (this.localModelPath) {
        // Own local model → never hit the network. Treat the path as
        // <dir>/<model-folder>: load <model-folder> out of <dir>.
        const norm  = this.localModelPath.replace(/\\/g, "/").replace(/\/+$/, "");
        const slash = norm.lastIndexOf("/");
        tf.env.allowRemoteModels = false;
        tf.env.allowLocalModels  = true;
        tf.env.localModelPath = slash >= 0 ? norm.slice(0, slash) : ".";
        modelToLoad = slash >= 0 ? norm.slice(slash + 1) : norm;
      } else {
        tf.env.allowRemoteModels = true;   // fetch + cache the default model once
      }
      this.pipe = await tf.pipeline("feature-extraction", modelToLoad);
      this.status = "ready";
      this.lastError = "";
      return true;
    } catch (e) {
      // Load failed → tier stays off, plugin keeps working. Surface why.
      this.status = "error";
      this.lastError = e instanceof Error ? e.message : String(e);
      this.pipe = null;
      console.error("[auto-linker] semantic model failed to load:", e);
      return false;
    }
  }

  async embed(text: string): Promise<Float32Array | null> {
    if (!this.pipe) return null;
    try {
      const out = await this.pipe(text, { pooling: "mean", normalize: true });
      return out.data instanceof Float32Array ? out.data : new Float32Array(out.data);
    } catch {
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Semantic index — caches note vectors (persisted) + sentence vectors (session)
// ---------------------------------------------------------------------------

interface NoteVec { mtime: number; vec: Float32Array; }

export class SemanticIndex {
  private noteVecs = new Map<string, NoteVec>();        // path → {mtime, vec}
  private sentenceVecs = new Map<string, Float32Array>(); // sentence text → vec (session only)
  private pending = new Set<string>();                   // in-flight embed keys (dedup)

  constructor(private embedder: Embedder) {}

  isReady(): boolean { return this.embedder.isReady(); }

  // ── synchronous cache reads (used by the scorer; never blocks) ─────────────

  /** Note vector iff cached AND current for `mtime`; else undefined. */
  noteVecSync(path: string, mtime: number): Float32Array | undefined {
    const e = this.noteVecs.get(path);
    return e && e.mtime === mtime ? e.vec : undefined;
  }
  sentenceVecSync(sentence: string): Float32Array | undefined {
    return this.sentenceVecs.get(sentence.trim());
  }

  /** semScore for a (sentence, note) pair from cache, or null if not yet warm. */
  semScoreSync(sentence: string, notePath: string, noteMtime: number): number | null {
    const s = this.sentenceVecSync(sentence);
    const n = this.noteVecSync(notePath, noteMtime);
    if (!s || !n) return null;
    return toSemScore(cosine(s, n));
  }

  // ── async warming (fills caches, then caller rescans) ──────────────────────

  async warmSentence(sentence: string): Promise<boolean> {
    const key = sentence.trim();
    if (!key || this.sentenceVecs.has(key) || this.pending.has("s:" + key)) return false;
    if (!this.embedder.isReady()) return false;
    this.pending.add("s:" + key);
    const v = await this.embedder.embed(key);
    this.pending.delete("s:" + key);
    if (v) { this.sentenceVecs.set(key, v); return true; }
    return false;
  }

  async warmNote(path: string, mtime: number, text: string): Promise<boolean> {
    if (this.noteVecSync(path, mtime) || this.pending.has("n:" + path)) return false;
    if (!this.embedder.isReady()) return false;
    this.pending.add("n:" + path);
    const v = await this.embedder.embed(text);
    this.pending.delete("n:" + path);
    if (v) { this.noteVecs.set(path, { mtime, vec: v }); return true; }
    return false;
  }

  clearSentences() { this.sentenceVecs.clear(); }

  // ── persistence (note vectors only → embeddings.json, NOT data.json) ───────

  serialize(): Record<string, { mtime: number; vec: number[] }> {
    const out: Record<string, { mtime: number; vec: number[] }> = {};
    for (const [path, { mtime, vec }] of this.noteVecs) out[path] = { mtime, vec: Array.from(vec) };
    return out;
  }
  load(data: Record<string, { mtime: number; vec: number[] }> | null | undefined) {
    this.noteVecs.clear();
    if (!data) return;
    for (const [path, { mtime, vec }] of Object.entries(data)) {
      this.noteVecs.set(path, { mtime, vec: new Float32Array(vec) });
    }
  }
}

// ---------------------------------------------------------------------------
// Sentence extraction — the sentence containing [from,to] within `text`
// ---------------------------------------------------------------------------

/** Smallest sentence-ish window containing the span, bounded by .!?/newlines. */
export function sentenceAround(text: string, from: number, to: number): string {
  let s = from, e = to;
  while (s > 0 && !/[.!?\n]/.test(text[s - 1])) s--;
  while (e < text.length && !/[.!?\n]/.test(text[e])) e++;
  return text.slice(s, e).trim();
}
