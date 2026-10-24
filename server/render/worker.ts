// A lazily started worker thread running vendored code (a gzipped ES module given as a data: URL, so it needs no file and no
// node_modules), one job at a time, with a hard timeout: on overrun the worker is terminated and the next job starts a fresh one.
// An idle worker is dropped after `idleMs` to give its memory back. Protocol: the worker posts {ready:true} once, then answers
// each {id, ...job} with {id, ...result}.
import { gunzipSync } from "node:zlib";
import { Worker } from "node:worker_threads";

export class TimedWorker<Job extends object, Result extends object> {
  private worker: Worker | null = null;
  private ready: Promise<Worker> | null = null;
  private idle: ReturnType<typeof setTimeout> | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private seq = 0;

  private gzB64: string;
  private label: string;
  private defaultTimeoutMs: number;
  private idleMs: number;

  constructor(gzB64: string, label: string, defaultTimeoutMs: number, idleMs = 30_000) {
    this.gzB64 = gzB64; this.label = label; this.defaultTimeoutMs = defaultTimeoutMs; this.idleMs = idleMs;
  }

  private spawn(): Promise<Worker> {
    return (this.ready ??= new Promise<Worker>((resolve, reject) => {
      const src = gunzipSync(Buffer.from(this.gzB64, "base64"));
      const w = new Worker(new URL(`data:text/javascript;base64,${src.toString("base64")}`) as never);
      this.worker = w;
      const fail = (e: Error) => { if (this.worker === w) { this.worker = null; this.ready = null; } reject(e); };
      w.once("error", fail);
      w.once("exit", () => fail(new Error(`the ${this.label} worker stopped`)));
      const onReady = (m: { ready?: boolean; error?: string }) => {
        if (m.ready === undefined) return;
        w.off("message", onReady);
        if (m.ready) { w.unref(); resolve(w); } else fail(new Error(m.error ?? `${this.label} failed to start`));
      };
      w.on("message", onReady);
    }));
  }

  stop() {
    const w = this.worker;
    this.worker = null; this.ready = null;
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    if (w) void w.terminate();
  }

  /** Rejects with `overrun` (the message for the agent) when the job takes longer than the timeout. */
  run(job: Job, overrun: (ms: number) => string, timeoutMs = this.defaultTimeoutMs): Promise<Result> {
    // one job at a time: a worker is single-threaded and RAM is the constraint
    const p = this.tail.then(() => this.exec(job, overrun, timeoutMs));
    this.tail = p.catch(() => undefined);
    return p;
  }

  private async exec(job: Job, overrun: (ms: number) => string, timeoutMs: number): Promise<Result> {
    const w = await this.spawn();
    const id = ++this.seq;
    return new Promise<Result>((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); this.stop(); reject(new Error(overrun(timeoutMs))); }, timeoutMs);
      const onMsg = (m: { id?: number } & Record<string, unknown>) => { if (m.id === id) { cleanup(); resolve(m as unknown as Result); } };
      const onExit = () => { cleanup(); reject(new Error(`the ${this.label} worker stopped`)); };
      const cleanup = () => { clearTimeout(timer); w.off("message", onMsg); w.off("exit", onExit); if (this.idle) clearTimeout(this.idle); this.idle = setTimeout(() => this.stop(), this.idleMs); this.idle.unref(); };
      w.on("message", onMsg);
      w.once("exit", onExit);
      w.postMessage({ id, ...job });
    });
  }
}
