/** main.ts releases the unsaved-work gate's pending question on every event that means the
 *  renderer can no longer answer it (#1419 review). The first cut released only on 'closed' and a
 *  project switch; an HMR reload under an open modal then stranded the question, and since a close
 *  or quit with a question pending is dropped, the window became unclosable. The client's own
 *  policy is covered in unsavedGateClient.test.ts; this pins that main WIRES the release. */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const MAIN = path.resolve(__dirname, '../../electron/main.ts');
const sf = ts.createSourceFile(MAIN, fs.readFileSync(MAIN, 'utf8'), ts.ScriptTarget.Latest, true);

/** Every `<x>.on('<event>', handler)` whose handler contains a `unsavedGate.releaseAll()` CALL. */
function eventsThatRelease(): Set<string> {
  const out = new Set<string>();
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'on'
      && n.arguments.length === 2 && ts.isStringLiteral(n.arguments[0])) {
      let releases = false;
      const find = (m: ts.Node) => {
        if (ts.isCallExpression(m) && m.expression.getText(sf) === 'unsavedGate.releaseAll') releases = true;
        ts.forEachChild(m, find);
      };
      find(n.arguments[1]);
      if (releases) out.add(n.arguments[0].text);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

describe('main.ts releases the unsaved-work question when the renderer cannot answer it', () => {
  it('on unresponsive, render-process-gone and a COMMITTED main-frame navigation', () => {
    const ev = eventsThatRelease();
    // `did-navigate`, never `did-start-navigation`: the start event also fires for navigations
    // that do not replace the document (blocked, a download, a 204), and releasing there lost the
    // prompt on the next quit (#1419 second review, observed on Electron 43.2).
    expect(ev.has('did-start-navigation'), 'did-start-navigation must not release').toBe(false);
    for (const e of ['unresponsive', 'render-process-gone', 'did-navigate']) {
      expect(ev.has(e), `'${e}' handler must call unsavedGate.releaseAll()`).toBe(true);
    }
  });

  it('failPendingRenderer (window closed, project switch) releases it too', () => {
    let found = false;
    const visit = (n: ts.Node) => {
      if (ts.isFunctionDeclaration(n) && n.name?.text === 'failPendingRenderer') {
        found = n.body!.statements.some((s) => s.getText(sf).startsWith('unsavedGate.releaseAll('));
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    expect(found).toBe(true);
  });

  it("the window 'close' gate lets an update install's own close through (no second ask)", () => {
    let guard: string | null = null;
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'on'
        && ts.isStringLiteral(n.arguments[0]) && n.arguments[0].text === 'close') {
        const fn = n.arguments[1];
        if ((ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && ts.isBlock(fn.body)) {
          const first = fn.body.statements.find(ts.isIfStatement);
          guard = first ? first.expression.getText(sf) : null;
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    expect(guard).toBe('closeApproved || isUpdateInstalling()');
  });
});

