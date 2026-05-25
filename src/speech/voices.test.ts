import { beforeEach, describe, expect, it } from 'vitest';
import {
  KOKORO_DEFAULT_VOICE,
  KOKORO_VOICES,
  browserVoiceId,
  defaultVoiceForEngine,
  isKokoroVoice,
  loadPreferredVoice,
  populateVoiceSelect,
} from './voices';

describe('isKokoroVoice', () => {
  it('recognises known Kokoro ids', () => {
    expect(isKokoroVoice('af_heart')).toBe(true);
    expect(isKokoroVoice('bm_lewis')).toBe(true);
    expect(isKokoroVoice('not-a-voice')).toBe(false);
  });
});

describe('loadPreferredVoice', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns defaults when nothing is stored', () => {
    expect(loadPreferredVoice('kokoro')).toBe(KOKORO_DEFAULT_VOICE);
    expect(loadPreferredVoice('web-speech')).toBeTruthy();
  });

  it('restores a saved Kokoro voice', () => {
    localStorage.setItem('pdf-read-aloud.voice.kokoro', 'af_bella');
    expect(loadPreferredVoice('kokoro')).toBe('af_bella');
  });

  it('ignores invalid stored Kokoro voices', () => {
    localStorage.setItem('pdf-read-aloud.voice.kokoro', 'nope');
    expect(loadPreferredVoice('kokoro')).toBe(KOKORO_DEFAULT_VOICE);
  });
});

describe('defaultVoiceForEngine', () => {
  it('prefers en-US browser voices when available', () => {
    const id = defaultVoiceForEngine('web-speech');
    expect(id).toBe('fake://en-US');
  });
});

describe('populateVoiceSelect', () => {
  it('fills options and selects the current voice', () => {
    const select = document.createElement('select');
    populateVoiceSelect(select, KOKORO_VOICES.slice(0, 3), 'af_bella');
    expect(select.options).toHaveLength(3);
    expect(select.value).toBe('af_bella');
  });

  it('disables the control when no voices exist', () => {
    const select = document.createElement('select');
    populateVoiceSelect(select, [], '');
    expect(select.disabled).toBe(true);
    expect(select.options[0]?.textContent).toBe('No voices');
  });
});

describe('browserVoiceId', () => {
  it('uses voiceURI when present', () => {
    expect(
      browserVoiceId({
        name: 'Test',
        lang: 'en-US',
        voiceURI: 'custom://voice',
      } as SpeechSynthesisVoice),
    ).toBe('custom://voice');
  });
});
