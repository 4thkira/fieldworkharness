import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ATTACHMENT_SCHEME, attachmentSummary, createAttachmentStore } from '../src/attachments.mjs';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const pngUrl = `data:image/png;base64,${PNG.toString('base64')}`;
const textUrl = text => `data:text/plain;base64,${Buffer.from(text, 'utf8').toString('base64')}`;

async function store(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fieldwork-attachments-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return { dir, attachments: await createAttachmentStore({ dir }) };
}

test('pictures are saved once by hash and kept in messages as small references', async t => {
  const { dir, attachments } = await store(t);
  const first = await attachments.accept([{ name: 'leaf.png', dataUrl: pngUrl }]);
  const again = await attachments.accept([{ name: 'same.png', dataUrl: pngUrl }]);
  assert.equal(first.parts[0].type, 'image_url');
  assert.match(first.parts[0].image_url.url, new RegExp(`^${ATTACHMENT_SCHEME}[0-9a-f]{64}$`));
  assert.equal(first.parts[0].image_url.url, again.parts[0].image_url.url, 'the same picture is stored once');
  assert.equal((await fs.readdir(dir)).filter(name => name.endsWith('.png')).length, 1);

  const expanded = await attachments.expand([{ role: 'user', content: [{ type: 'text', text: 'look' }, ...first.parts] }]);
  assert.equal(expanded[0].content[1].image_url.url, pngUrl, 'the model receives the real picture');
  assert.deepEqual(attachmentSummary([{ type: 'text', text: 'look' }, ...first.parts]), [{ kind: 'image', ref: first.summary[0].ref }]);
});

test('text files become labelled text, and unreadable or unknown kinds are refused plainly', async t => {
  const { attachments } = await store(t);
  const { parts, summary } = await attachments.accept([{ name: 'notes.md', dataUrl: textUrl('# Moss\nGrows slowly.') }]);
  assert.equal(parts[0].text, '[Attached file: notes.md]\n# Moss\nGrows slowly.\n[End of notes.md]');
  assert.deepEqual(summary, [{ kind: 'file', name: 'notes.md', bytes: 20 }]);
  assert.deepEqual(attachmentSummary(parts), [{ kind: 'file', name: 'notes.md', text: '# Moss\nGrows slowly.' }], 'the browser gets the text for a preview');

  await assert.rejects(attachments.accept([{ name: 'paper.pdf', dataUrl: `data:application/pdf;base64,${Buffer.from('%PDF-1.7').toString('base64')}` }]), /cannot read yet.*PDFs and documents are planned/);
  await assert.rejects(attachments.accept([{ name: 'fake.png', dataUrl: `data:image/png;base64,${Buffer.from('not a picture').toString('base64')}` }]), /not a picture type/);
  await assert.rejects(attachments.accept([{ name: 'bad.txt', dataUrl: `data:text/plain;base64,${Buffer.from([0xff, 0xfe, 0xfd]).toString('base64')}` }]), /not readable text/);
  await assert.rejects(attachments.accept(Array.from({ length: 5 }, () => ({ name: 'a.txt', dataUrl: textUrl('x') }))), /at most 4/);
  await assert.rejects(attachments.accept([{ name: 'big.txt', dataUrl: textUrl('x'.repeat(201 * 1024)) }]), /at most 200 KB/);
  await assert.rejects(attachments.accept([{ name: 'x.txt', dataUrl: 'https://example.com/x.txt' }]), /base64 data URL/);
});

test('a missing picture becomes an honest note instead of breaking the request', async t => {
  const { attachments } = await store(t);
  const expanded = await attachments.expand([{ role: 'user', content: [{ type: 'image_url', image_url: { url: `${ATTACHMENT_SCHEME}${'0'.repeat(64)}` } }] }]);
  assert.match(expanded[0].content[0].text, /no longer in the agent's folder/);
  await assert.rejects(attachments.dataUrl('../../secret'), /not an attachment reference/);
});

test('newest pictures fit a bounded provider request while older ones remain saved', async t => {
  const { attachments } = await store(t);
  const oldBytes = Buffer.concat([PNG, Buffer.from([5])]);
  const newBytes = Buffer.concat([PNG, Buffer.from([6, 7])]);
  const old = await attachments.accept([{ name: 'old.png', dataUrl: `data:image/png;base64,${oldBytes.toString('base64')}` }]);
  const recent = await attachments.accept([{ name: 'recent.png', dataUrl: `data:image/png;base64,${newBytes.toString('base64')}` }]);
  const savedOldRef = old.parts[0].image_url.url;
  const expanded = await attachments.expand([
    { role: 'user', content: old.parts },
    { role: 'assistant', content: 'later' },
    { role: 'user', content: recent.parts },
  ], { maxImageBytes: newBytes.length });
  assert.match(expanded[0].content[0].text, /not sent to the model.*remains saved/);
  assert.equal(expanded[2].content[0].image_url.url, `data:image/png;base64,${newBytes.toString('base64')}`);
  assert.equal(old.parts[0].image_url.url, savedOldRef, 'the archived reference is not mutated');
});

test('a conversation title is what the person wrote, not a structurally marked attached file', async t => {
  const { conversationTitle } = await import('../src/conversation-store.mjs');
  const { attachments } = await store(t);
  const file = (await attachments.accept([{ name: 'care.txt', dataUrl: textUrl('Basil likes sun.') }])).parts[0];
  assert.equal(conversationTitle([{ role: 'user', content: [{ type: 'text', text: 'What does it say?' }, file] }]), 'What does it say?');
  assert.equal(conversationTitle([{ role: 'user', content: [file] }]), 'care.txt');
  assert.equal(conversationTitle([{ role: 'user', content: [{ type: 'image_url', image_url: { url: `${ATTACHMENT_SCHEME}${'a'.repeat(64)}` } }] }]), 'A picture');

  const literal = { type: 'text', text: '[Attached file: care.txt]\nThese are my own words.' };
  assert.deepEqual(attachmentSummary([literal]), []);
  assert.equal(conversationTitle([{ role: 'user', content: [literal] }]), '[Attached file: care.txt] These are my own words.');
});
