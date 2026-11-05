/**
 * The store revision a purge preview returns and `expectedRevision` checks (kontourai/corpus#69).
 *
 * It is a keyed digest of the raw bytes of every record note and every file in the proposals
 * directory, with their names. Nothing is parsed, so computing the revision never fails on a
 * corrupt file, and a pending or rejected proposal can still be previewed and erased beside a
 * corrupt one (a record preview still stops on a corrupt proposal, as `purge` does). A file too
 * large to read is listed by name alone. Nothing is stored either: the store
 * keeps no counter, so a person editing a vault by hand moves the revision too. Any write to a
 * record, any write to a proposal (including a request key's first use, and a key retired by a
 * scrub) and any external edit changes it. A request-key retry that matches an existing
 * proposal writes nothing and leaves it alone, which is right: the plan did not change.
 *
 * The key is the root binding (the root's path and identity marker), so a token cannot be
 * confirmed against a guess at the store's content without the marker. A root without one has no
 * key, so the adapters refuse to make a revision for it (`ROOT_BINDING_MISMATCH`) until the host
 * initializes the root. The key is not a secret between hosts: it only keeps a retained token
 * from being a plain hash of the data.
 */
import { createHmac } from 'node:crypto';

export const REVISION_PREFIX = 'rev1:';

export class StoreRevision {
  private readonly hmac;

  constructor(key: string) {
    this.hmac = createHmac('sha256', key);
  }

  /** `text` is a file's bytes as text, or null if it is absent. Callers add in a fixed order. */
  add(kind: 'record' | 'proposal', name: string, text: string | null): void {
    // Length-prefixed, so two different sets of files can never frame to the same bytes.
    this.hmac.update(`${kind}\0${Buffer.byteLength(name)}\0${name}\0${text === null ? '-' : Buffer.byteLength(text)}\0`);
    if (text !== null) this.hmac.update(text);
  }

  value(): string {
    return `${REVISION_PREFIX}${this.hmac.digest('hex')}`;
  }
}
