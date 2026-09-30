/** #1879: the hold in front of the watcher's reloads. Mutations: drop the `delete` before the `set` in `hold` → "a second
 *  write moves the file to the end"; let `putBack` overwrite → "a newer write beats a put-back"; drop `notify` in `take`
 *  → "listeners hear the list empty". */
import { describe, it, expect } from 'vitest';
import { createOutsideChangeHold } from '../../app/debug/outsideChangeHold';

type M = { urlPath: string; n: number };

describe('createOutsideChangeHold', () => {
  it('holds by path, a second write moves the file to the end with its newest message', () => {
    const h = createOutsideChangeHold<M>();
    h.hold({ urlPath: 'a', n: 1 });
    h.hold({ urlPath: 'b', n: 2 });
    h.hold({ urlPath: 'a', n: 3 });
    expect(h.paths()).toEqual(['b', 'a']);
    expect(h.take()).toEqual([{ urlPath: 'b', n: 2 }, { urlPath: 'a', n: 3 }]);
    expect(h.paths()).toEqual([]);
  });

  it('a newer write beats a put-back', () => {
    const h = createOutsideChangeHold<M>();
    h.hold({ urlPath: 's', n: 1 });
    const taken = h.take();
    h.hold({ urlPath: 's', n: 2 }); // written again while the release ran
    h.putBack(taken);
    expect(h.take()).toEqual([{ urlPath: 's', n: 2 }]);
  });

  it('listeners hear every change of the list, including it going empty', () => {
    const h = createOutsideChangeHold<M>();
    const heard: string[][] = [];
    const off = h.onChange((p) => heard.push(p));
    h.hold({ urlPath: 'a', n: 1 });
    h.take();
    h.take(); // nothing held: no news
    h.putBack([{ urlPath: 'b', n: 2 }]);
    off();
    h.hold({ urlPath: 'c', n: 3 });
    expect(heard).toEqual([['a'], [], ['b']]);
  });
});
