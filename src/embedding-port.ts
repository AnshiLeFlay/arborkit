/** Turns text into vectors. Swappable; production adapters (OpenAI, local, etc.) implement this. */
export interface EmbeddingPort {
  readonly dims: number;
  embed(texts: string[]): Promise<number[][]>;
}

/**
 * Deterministic test/dev embedding: sums char codes into fixed-dimension buckets.
 * Same text → same vector (so an exact-text query ranks its node first); no network.
 */
export class MockEmbeddingPort implements EmbeddingPort {
  constructor(readonly dims = 32) {}

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.vectorize(t));
  }

  private vectorize(text: string): number[] {
    const v = new Array<number>(this.dims).fill(0);
    for (let i = 0; i < text.length; i++) {
      v[i % this.dims] += text.charCodeAt(i);
    }
    return v;
  }
}
