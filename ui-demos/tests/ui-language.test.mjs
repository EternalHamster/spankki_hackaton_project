import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { localizeUI } from '../public/ui-language.js';
import { LANGUAGE_KEY } from '../public/language.js';

// Minimal DOM surface for the rendering boundary; values and text nodes are separate,
// just as they are for a textarea after a user edits its initial contents.
function element(tag, attributes = {}, children = []) {
  const node = {
    nodeType: 1, tag, attributes: { ...attributes }, children, parentElement: null,
    value: '',
    hasAttribute(name) { return Object.hasOwn(this.attributes, name); },
    getAttribute(name) { return this.attributes[name] ?? null; },
    setAttribute(name, value) { this.attributes[name] = value; },
    closest(selector) {
      const selectors = selector.split(',').map(value => value.trim());
      for (let current = this; current; current = current.parentElement) {
        if (selectors.includes(current.tag) ||
            (selectors.includes('[data-no-translate]') && current.hasAttribute('data-no-translate'))) return current;
      }
      return null;
    },
    querySelectorAll() { return this.children.filter(child => child.nodeType === 1)
      .flatMap(child => [child, ...child.querySelectorAll()]); },
  };
  for (const child of children) child.parentElement = node;
  return node;
}
const text = nodeValue => ({ nodeType: 3, nodeValue, parentElement: null });

function fixture(t, language = 'en') {
  for (const [name, value] of Object.entries({
    localStorage: { getItem: key => key === LANGUAGE_KEY ? language : null },
    NodeFilter: { SHOW_TEXT: 4 },
    document: { createTreeWalker(root) {
      const collect = node => node.nodeType === 3 ? [node] : node.children.flatMap(collect);
      const nodes = collect(root);
      return { currentNode: root, nextNode() { this.currentNode = nodes.shift(); return this.currentNode; } };
    } },
  })) {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value });
    t.after(() => descriptor ? Object.defineProperty(globalThis, name, descriptor) : delete globalThis[name]);
  }
}

test('every current form placeholder localizes without rewriting user input', t => {
  fixture(t);
  const controls = ['app.js', 'chat.js'].flatMap(file => {
    const source = readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8');
    return [...source.matchAll(/<(textarea|input)\b[^>]*\bplaceholder="([^"]+)"/g)]
      .map(([, tag, placeholder]) => {
        const control = element(tag, { placeholder }, tag === 'textarea' ? [text('Uusi pyörä')] : []);
        control.value = 'Lomamatka';
        return { control, placeholder };
      });
  });
  assert.equal(controls.length, 3);
  localizeUI(element('form', {}, controls.map(({ control }) => control)));
  assert.deepEqual(controls.map(({ control }) => control.getAttribute('placeholder')), [
    'Ask about your finances…',
    "I'd like a new bike, but I'm not sure how much I could save each month…",
    'Type your question…',
  ]);
  for (const { control } of controls) {
    assert.equal(control.value, 'Lomamatka');
    if (control.tag === 'textarea') assert.equal(control.children[0].nodeValue, 'Uusi pyörä');
  }
});

test('updated textarea attributes localize while text-node updates and explicit opt-outs stay intact', t => {
  fixture(t);
  const attributes = Object.fromEntries(['placeholder', 'title', 'aria-label', 'aria-description', 'aria-valuetext', 'aria-roledescription']
    .map(name => [name, 'Kirjoita kysymyksesi']));
  const draft = text('Uusi pyörä'), control = element('textarea', attributes, [draft]);
  localizeUI(control);
  for (const name of Object.keys(attributes)) assert.equal(control.getAttribute(name), 'Type your question');
  control.setAttribute('placeholder', 'Mitä haluaisit toteuttaa?');
  localizeUI(control);
  assert.equal(control.getAttribute('placeholder'), 'What would you like to do?');
  draft.nodeValue = 'Lomamatka';
  localizeUI(draft);
  assert.equal(draft.nodeValue, 'Lomamatka');

  const optedOut = element('textarea', attributes, [text('Uusi pyörä')]);
  localizeUI(element('section', { 'data-no-translate': '' }, [optedOut]));
  assert.deepEqual(optedOut.attributes, attributes);
  assert.equal(optedOut.children[0].nodeValue, 'Uusi pyörä');
});

test('Finnish rendering retains Finnish form copy and the user draft', t => {
  fixture(t, 'fi');
  const control = element('textarea', { placeholder: 'Kirjoita kysymyksesi…' }, [text('My bike')]);
  control.value = 'My holiday';
  localizeUI(element('form', {}, [control]));
  assert.equal(control.getAttribute('placeholder'), 'Kirjoita kysymyksesi…');
  assert.equal(control.children[0].nodeValue, 'My bike');
  assert.equal(control.value, 'My holiday');
});
