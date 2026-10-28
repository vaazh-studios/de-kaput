import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deobfuscateEvent, parseMapping } from '../src/mapping.mjs';

const mapping = `# compiler: R8
# compiler_version: 9.2.14
com.example.app.ui.tabs.HomeTab -> sm8:
    int count -> a
    void render() -> b
com.example.app.data.Parser -> ab:
com.example.app.Was -> was:
`;

test('class lines are read, member lines are not', () => {
  const map = parseMapping(mapping);
  assert.equal(map.get('sm8'), 'com.example.app.ui.tabs.HomeTab');
  assert.equal(map.get('ab'), 'com.example.app.data.Parser');
  assert.equal(map.has('a'), false);
});

test('a renamed class in the message is read back to its real name', () => {
  const event = {
    subtitle: 'java.lang.IllegalArgumentException - Key sm8:currentTab was used multiple times ',
    exceptions: 'java.lang.IllegalArgumentException: Key sm8:currentTab was used multiple times \nat androidx.compose.Foo.bar (Foo.kt:1)',
  };
  const { event: out, decoded } = deobfuscateEvent(event, parseMapping(mapping));
  assert.match(out.subtitle, /Key com\.example\.app\.ui\.tabs\.HomeTab:currentTab was used/);
  assert.match(out.exceptions.split('\n')[0], /Key com\.example\.app\.ui\.tabs\.HomeTab:currentTab/);
  assert.deepEqual(decoded, { sm8: 'com.example.app.ui.tabs.HomeTab' });
});

test('plain words that happen to be R8 names are left alone', () => {
  const event = { subtitle: 'java.lang.IllegalStateException - it was ab and was not ready', exceptions: '' };
  const { event: out, decoded } = deobfuscateEvent(event, parseMapping(mapping));
  assert.equal(out.subtitle, event.subtitle);
  assert.deepEqual(decoded, {});
});

test('frames are never touched; Crashlytics already deobfuscates them', () => {
  const event = { subtitle: 'x', exceptions: 'java.lang.Error: boom sm8:\nat sm8.a (SourceFile:1)' };
  const { event: out } = deobfuscateEvent(event, parseMapping(mapping));
  assert.equal(out.exceptions.split('\n')[1], 'at sm8.a (SourceFile:1)');
});
