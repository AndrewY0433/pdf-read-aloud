import type { EngineId } from './engine';

export type VoiceOption = {
  id: string;
  label: string;
};

const VOICE_PREF_PREFIX = 'pdf-read-aloud.voice.';

export const KOKORO_DEFAULT_VOICE = 'af_heart';

/** Curated Kokoro voices; ids match kokoro-js / Kokoro-82M ONNX. */
export const KOKORO_VOICES = [
  { id: 'af_heart', label: 'Heart (US, female)' },
  { id: 'af_bella', label: 'Bella (US, female)' },
  { id: 'af_sarah', label: 'Sarah (US, female)' },
  { id: 'af_nicole', label: 'Nicole (US, female)' },
  { id: 'af_kore', label: 'Kore (US, female)' },
  { id: 'af_alloy', label: 'Alloy (US, female)' },
  { id: 'af_aoede', label: 'Aoede (US, female)' },
  { id: 'af_jessica', label: 'Jessica (US, female)' },
  { id: 'af_nova', label: 'Nova (US, female)' },
  { id: 'af_river', label: 'River (US, female)' },
  { id: 'af_sky', label: 'Sky (US, female)' },
  { id: 'am_michael', label: 'Michael (US, male)' },
  { id: 'am_fenrir', label: 'Fenrir (US, male)' },
  { id: 'am_puck', label: 'Puck (US, male)' },
  { id: 'am_adam', label: 'Adam (US, male)' },
  { id: 'am_echo', label: 'Echo (US, male)' },
  { id: 'am_eric', label: 'Eric (US, male)' },
  { id: 'am_liam', label: 'Liam (US, male)' },
  { id: 'am_onyx', label: 'Onyx (US, male)' },
  { id: 'am_santa', label: 'Santa (US, male)' },
  { id: 'bf_emma', label: 'Emma (UK, female)' },
  { id: 'bf_isabella', label: 'Isabella (UK, female)' },
  { id: 'bm_george', label: 'George (UK, male)' },
  { id: 'bm_lewis', label: 'Lewis (UK, male)' },
] as const satisfies readonly VoiceOption[];

export type KokoroVoiceId = (typeof KOKORO_VOICES)[number]['id'];

const KOKORO_VOICE_IDS = new Set<string>(KOKORO_VOICES.map((v) => v.id));

export function isKokoroVoice(id: string): id is KokoroVoiceId {
  return KOKORO_VOICE_IDS.has(id);
}

export function defaultVoiceForEngine(engineId: EngineId): string {
  if (engineId === 'kokoro') return KOKORO_DEFAULT_VOICE;
  return pickDefaultBrowserVoiceId(listBrowserVoices());
}

export function loadPreferredVoice(engineId: EngineId): string {
  try {
    const raw = localStorage.getItem(`${VOICE_PREF_PREFIX}${engineId}`);
    if (raw) {
      if (engineId === 'kokoro' && isKokoroVoice(raw)) return raw;
      if (engineId === 'web-speech' && raw.length > 0) return raw;
    }
  } catch {
    // localStorage unavailable
  }
  return defaultVoiceForEngine(engineId);
}

export function loadPreferredKokoroVoice(): KokoroVoiceId {
  const id = loadPreferredVoice('kokoro');
  return isKokoroVoice(id) ? id : KOKORO_DEFAULT_VOICE;
}

export function savePreferredVoice(engineId: EngineId, voiceId: string): void {
  try {
    localStorage.setItem(`${VOICE_PREF_PREFIX}${engineId}`, voiceId);
  } catch {
    // ignore quota / private-mode errors
  }
}

/** Stable id for a browser speechSynthesis voice. */
export function browserVoiceId(voice: SpeechSynthesisVoice): string {
  return voice.voiceURI || `${voice.name}|${voice.lang}`;
}

export function formatBrowserVoiceLabel(voice: SpeechSynthesisVoice): string {
  const lang = voice.lang?.replace(/_/g, '-') ?? '';
  return lang ? `${voice.name} (${lang})` : voice.name;
}

export function listBrowserVoices(): VoiceOption[] {
  const voices = speechSynthesis.getVoices();
  const seen = new Set<string>();
  const out: VoiceOption[] = [];

  for (const voice of voices) {
    const id = browserVoiceId(voice);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, label: formatBrowserVoiceLabel(voice) });
  }

  out.sort((a, b) => {
    const aEn = a.label.toLowerCase().includes('en');
    const bEn = b.label.toLowerCase().includes('en');
    if (aEn !== bEn) return aEn ? -1 : 1;
    return a.label.localeCompare(b.label);
  });

  return out;
}

export function pickDefaultBrowserVoiceId(options: VoiceOption[]): string {
  if (options.length === 0) return '';
  const enUs = options.find((v) => v.label.toLowerCase().includes('(en-us)'));
  if (enUs) return enUs.id;
  const en = options.find((v) => /\ben[-)]/i.test(v.label));
  return en?.id ?? options[0]!.id;
}

export function resolveBrowserVoice(voiceId: string): SpeechSynthesisVoice | null {
  if (!voiceId) return null;
  const voices = speechSynthesis.getVoices();
  return voices.find((v) => browserVoiceId(v) === voiceId) ?? null;
}

export function populateVoiceSelect(
  select: HTMLSelectElement,
  options: VoiceOption[],
  selectedId: string,
): void {
  select.replaceChildren();
  if (options.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'No voices';
    select.append(opt);
    select.disabled = true;
    return;
  }

  select.disabled = false;
  let hasSelected = false;
  for (const opt of options) {
    const el = document.createElement('option');
    el.value = opt.id;
    el.textContent = opt.label;
    if (opt.id === selectedId) {
      el.selected = true;
      hasSelected = true;
    }
    select.append(el);
  }
  if (!hasSelected) select.value = options[0]!.id;
}
