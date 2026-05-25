import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { PlaybackHooks } from './engine';
import type { WordEntity } from '../types';

// Hoisted: build a fresh kokoro-js mock per test via the module variable below.
const generateMock = vi.fn();
const fromPretrainedMock = vi.fn();

vi.mock('kokoro-js', () => ({
  KokoroTTS: {
    from_pretrained: fromPretrainedMock,
  },
}));

// Import the engine AFTER the mock so its dynamic import sees the stub.
import { KokoroEngine } from './kokoroEngine';

function makeWords(text: string): { words: WordEntity[]; speakText: string } {
  const tokens = text.split(/\s+/).filter(Boolean);
  let offset = 0;
  const words: WordEntity[] = tokens.map((t, i) => {
    const charStart = offset;
    const charEnd = offset + t.length;
    offset = charEnd + 1;
    return {
      pageIndex: 0,
      wordIndex: i,
      sentenceId: 0,
      text: t,
      charStart,
      charEnd,
      left: 0,
      top: 0,
      width: t.length * 7,
      height: 12,
    };
  });
  return { words, speakText: words.map((w) => w.text).join(' ') };
}

type MockedHooks = {
  onWordIndex: Mock;
  onIdle: Mock;
  onStatus: Mock;
  onEngineReady: Mock;
};

function makeHooks(): MockedHooks {
  return {
    onWordIndex: vi.fn(),
    onIdle: vi.fn(),
    onStatus: vi.fn(),
    onEngineReady: vi.fn(),
  };
}

function asPlaybackHooks(h: MockedHooks): PlaybackHooks {
  return h as unknown as PlaybackHooks;
}

function installNoWebGpu(): void {
  Object.defineProperty(globalThis.navigator, 'gpu', {
    value: undefined,
    configurable: true,
  });
}

function installWebGpu(): void {
  Object.defineProperty(globalThis.navigator, 'gpu', {
    value: { requestAdapter: vi.fn().mockResolvedValue({}) },
    configurable: true,
  });
}

beforeEach(() => {
  generateMock.mockReset();
  generateMock.mockResolvedValue({
    audio: new Float32Array(240), // ~10 ms of silence at 24 kHz
    sampling_rate: 24000,
  });
  fromPretrainedMock.mockReset();
  fromPretrainedMock.mockResolvedValue({ generate: generateMock });
  // Default to no WebGPU; individual tests can flip this on.
  installNoWebGpu();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('KokoroEngine.prepare', () => {
  it('lazy-loads the model on first prepare() and caches subsequent calls', async () => {
    const engine = new KokoroEngine(asPlaybackHooks(makeHooks()));
    await engine.prepare();
    await engine.prepare();
    expect(fromPretrainedMock).toHaveBeenCalledTimes(1);
  });

  it('selects WASM + q8 when WebGPU is unavailable', async () => {
    const hooks = makeHooks();
    const engine = new KokoroEngine(asPlaybackHooks(hooks));
    await engine.prepare();
    expect(fromPretrainedMock).toHaveBeenCalledWith(
      'onnx-community/Kokoro-82M-v1.0-ONNX',
      expect.objectContaining({ device: 'wasm', dtype: 'q8' }),
    );
    expect(hooks.onEngineReady).toHaveBeenCalledWith('kokoro');
  });

  it('selects WebGPU + fp32 when an adapter resolves', async () => {
    installWebGpu();
    const engine = new KokoroEngine(asPlaybackHooks(makeHooks()));
    await engine.prepare();
    expect(fromPretrainedMock).toHaveBeenCalledWith(
      'onnx-community/Kokoro-82M-v1.0-ONNX',
      expect.objectContaining({ device: 'webgpu', dtype: 'fp32' }),
    );
  });

  it('surfaces progress via onStatus', async () => {
    const hooks = makeHooks();
    fromPretrainedMock.mockImplementation(async (_id: string, opts: { progress_callback?: (e: { status: string; progress: number }) => void }) => {
      opts.progress_callback?.({ status: 'progress', progress: 42 });
      opts.progress_callback?.({ status: 'progress', progress: 100 });
      return { generate: generateMock };
    });
    const engine = new KokoroEngine(asPlaybackHooks(hooks));
    await engine.prepare();
    expect(hooks.onStatus).toHaveBeenCalledWith(expect.stringContaining('42'));
    expect(hooks.onStatus).toHaveBeenCalledWith(null);
  });
});

describe('KokoroEngine.setContent', () => {
  it('breaks the document into one or more chunks', () => {
    const hooks = makeHooks();
    const engine = new KokoroEngine(asPlaybackHooks(hooks));
    const { words, speakText } = makeWords(
      'Hello there how are you doing today. Another sentence to make this longer.',
    );
    engine.setContent(words, speakText);
    // Internally chunks are built; we exercise via startAt and observe
    // that generation is invoked on at least the first chunk.
    return engine.prepare().then(() => {
      engine.startAt(0);
      // Give the generator microtask loop a tick.
      return new Promise<void>((r) => setTimeout(r, 30)).then(() => {
        expect(generateMock).toHaveBeenCalled();
      });
    });
  });
});

describe('KokoroEngine playback control', () => {
  it('startAt with no chunks immediately reports idle', () => {
    const hooks = makeHooks();
    const engine = new KokoroEngine(asPlaybackHooks(hooks));
    engine.setContent([], '');
    engine.startAt(0);
    expect(hooks.onIdle).toHaveBeenCalled();
    expect(fromPretrainedMock).not.toHaveBeenCalled();
  });

  it('startAt triggers prepare() and emits the chunk-start word index', async () => {
    const hooks = makeHooks();
    const engine = new KokoroEngine(asPlaybackHooks(hooks));
    const { words, speakText } = makeWords('Hello there friend, how are you today this afternoon.');
    engine.setContent(words, speakText);
    engine.startAt(0);
    await new Promise<void>((r) => setTimeout(r, 30));
    expect(fromPretrainedMock).toHaveBeenCalledTimes(1);
    expect(generateMock).toHaveBeenCalled();
    // The first chunk starts at word 0.
    expect(hooks.onWordIndex).toHaveBeenCalledWith(0);
  });

  it('passes the current rate to kokoro.generate', async () => {
    const engine = new KokoroEngine(asPlaybackHooks(makeHooks()));
    const { words, speakText } = makeWords('Speed test goes here today friend.');
    engine.setContent(words, speakText);
    engine.setRate(1.75);
    engine.startAt(0);
    await new Promise<void>((r) => setTimeout(r, 30));
    expect(generateMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ speed: 1.75 }),
    );
  });

  it('setRate is a no-op when the value is unchanged', () => {
    const engine = new KokoroEngine(asPlaybackHooks(makeHooks()));
    engine.setRate(1);
    // Should NOT throw even though there's no audio in flight.
    expect(() => engine.setRate(1)).not.toThrow();
  });

  it('stop clears chunks-in-flight and reports idle', async () => {
    const hooks = makeHooks();
    const engine = new KokoroEngine(asPlaybackHooks(hooks));
    const { words, speakText } = makeWords('Just a short test phrase here today friend.');
    engine.setContent(words, speakText);
    engine.startAt(0);
    await new Promise<void>((r) => setTimeout(r, 10));
    engine.stop();
    expect(hooks.onIdle).toHaveBeenCalled();
    expect(hooks.onWordIndex).toHaveBeenLastCalledWith(0);
  });

  it('dispose releases the model handle', async () => {
    const engine = new KokoroEngine(asPlaybackHooks(makeHooks()));
    await engine.prepare();
    engine.dispose();
    // After dispose a fresh prepare should reload the model.
    await engine.prepare();
    expect(fromPretrainedMock).toHaveBeenCalledTimes(2);
  });
});

describe('KokoroEngine error handling', () => {
  it('emits a friendly status when the model fails to load', async () => {
    fromPretrainedMock.mockRejectedValueOnce(new Error('network down'));
    const hooks = makeHooks();
    const engine = new KokoroEngine(asPlaybackHooks(hooks));
    const { words, speakText } = makeWords('hello there friend');
    engine.setContent(words, speakText);
    engine.startAt(0);
    await new Promise<void>((r) => setTimeout(r, 30));
    expect(hooks.onStatus).toHaveBeenCalledWith(
      expect.stringMatching(/failed to load/i),
    );
    expect(hooks.onIdle).toHaveBeenCalled();
  });
});
