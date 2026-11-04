import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { channelOn, visibleChats, tokenPatch } from './channels.ts';

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

test('Save and start sends a token only when one was typed', () => {
  assert.deepEqual(tokenPatch(''), { enabled: true });
  assert.deepEqual(tokenPatch('   '), { enabled: true });
  assert.deepEqual(tokenPatch('••••••abcd'), { enabled: true }, 'the mask is never sent');
  assert.deepEqual(tokenPatch('••••••abcd999:NEW-wxyz'), { enabled: true }, 'nor a token pasted onto it');
  assert.deepEqual(tokenPatch(' 999:NEW-wxyz '), { token: '999:NEW-wxyz', enabled: true });
});

test('the token boxes start empty: the masked value is a hint, never the input', () => {
  for (const f of ['../components/settings/TelegramSection.tsx', '../components/settings/DiscordSection.tsx']) {
    const src = read(f);
    assert.doesNotMatch(src, /setToken\([^)]*\.token/, `${f} loads the saved token into the box`);
    assert.match(src, /tokenPatch\(token\)/, `${f} sends through tokenPatch`);
  }
});

test('Discord is hidden while off: no Setup section, no conversations', () => {
  assert.equal(channelOn('discord'), false);
  const chats = [
    { channel: 'telegram' as const, chatId: '1' },
    { channel: 'discord' as const, chatId: '2' },
  ];
  assert.deepEqual(visibleChats(chats).map((c) => c.channel), ['telegram']);
  const phone = read('../components/PhoneView.tsx');
  for (const line of phone.split(/\r?\n/).filter((l) => l.includes('<DiscordSection'))) {
    assert.match(line, /channelOn\('discord'\) &&/, 'DiscordSection is rendered behind the flag');
  }
  assert.match(phone, /setChats\(visibleChats\(/);
  assert.match(read('../components/settings/DiscordSection.tsx'), /!channelOn\('discord'\)\) return null/);
});
