import assert from 'node:assert/strict';
import { test } from 'node:test';
import { slugify } from '../src/blog/slug.util';

test('slugify kebab-cases simple titles', () => {
  assert.equal(
    slugify('Turning the platform off at night'),
    'turning-the-platform-off-at-night',
  );
});

test('slugify drops apostrophes and punctuation', () => {
  assert.equal(
    slugify("Surf Green: Fender's happiest accident"),
    'surf-green-fenders-happiest-accident',
  );
});

test('slugify strips diacritics and trims hyphens', () => {
  assert.equal(slugify('  Événements & CQRS!  '), 'evenements-cqrs');
});

test('slugify collapses repeated separators', () => {
  assert.equal(slugify('a --- b___c'), 'a-b-c');
});

test('slugify returns empty string when nothing survives', () => {
  assert.equal(slugify('!!! ???'), '');
});
