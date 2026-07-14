/** Pure, deterministic vector helpers shared by analytics and vector adapters. */

export function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const length = Math.min(a.length, b.length);
  let result = 0;
  for (let index = 0; index < length; index++) result += a[index] * b[index];
  return result;
}

export function norm(vector: ArrayLike<number>): number {
  let squared = 0;
  for (let index = 0; index < vector.length; index++) squared += vector[index] * vector[index];
  return Math.sqrt(squared);
}

/** Unit-normalize a vector. A zero vector remains zero. */
export function normalize(vector: ArrayLike<number>): Float32Array {
  const result = new Float32Array(vector.length);
  const magnitude = norm(vector);
  if (magnitude === 0) return result;
  const inverse = 1 / magnitude;
  for (let index = 0; index < vector.length; index++) result[index] = vector[index] * inverse;
  return result;
}

/** Cosine similarity in [-1, 1], or zero when either vector has zero magnitude. */
export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const aNorm = norm(a);
  const bNorm = norm(b);
  if (aNorm === 0 || bNorm === 0) return 0;
  return dot(a, b) / (aNorm * bNorm);
}

/** Euclidean distance over the shared dimensions of two vectors. */
export function euclidean(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const length = Math.min(a.length, b.length);
  let squared = 0;
  for (let index = 0; index < length; index++) {
    const difference = a[index] - b[index];
    squared += difference * difference;
  }
  return Math.sqrt(squared);
}

/** Component-wise mean. All vectors must have the same dimension. */
export function centroid(vectors: ReadonlyArray<ArrayLike<number>>): number[] {
  if (vectors.length === 0) throw new Error("centroid(): empty input");
  const dimension = vectors[0].length;
  if (vectors.some((vector) => vector.length !== dimension)) {
    throw new Error("centroid(): all vectors must have the same dimension");
  }
  const result = new Array<number>(dimension).fill(0);
  for (const vector of vectors) {
    for (let index = 0; index < dimension; index++) result[index] += vector[index];
  }
  for (let index = 0; index < dimension; index++) result[index] /= vectors.length;
  return result;
}
