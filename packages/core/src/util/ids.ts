const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export type IdFactory = () => string;

/**
 * ULID generator. `now` and `random` are injectable so the synthetic data
 * generator can produce the same IDs for the same seed.
 */
export function createIdFactory(
  now: () => number = () => Date.now(),
  random: () => number = () => crypto.getRandomValues(new Uint32Array(1))[0]! / 4294967296,
): IdFactory {
  return () => {
    let time = now();
    let head = "";
    for (let i = 0; i < 10; i++) {
      head = ALPHABET[time % 32] + head;
      time = Math.floor(time / 32);
    }
    let tail = "";
    for (let i = 0; i < 16; i++) tail += ALPHABET[Math.floor(random() * 32)];
    return head + tail;
  };
}
