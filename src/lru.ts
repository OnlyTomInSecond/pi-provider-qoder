/**
 * A Map bounded to `maxSize` entries that evicts the least-recently-used key.
 * `get` refreshes recency (LRU), unlike a plain Map's insertion-order eviction.
 */
export class LruMap<K, V> {
  private readonly map = new Map<K, V>();

  constructor(private readonly maxSize: number) {}

  get size(): number {
    return this.map.size;
  }

  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value === undefined) return undefined;
    // Re-insert to move the key to the most-recent position.
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size <= this.maxSize) return;
    const oldest = this.map.keys().next().value;
    if (oldest !== undefined) this.map.delete(oldest);
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }
}
